import { haversineMeters } from './GraphCache.js';

export class AssignmentCandidateFinder {
  constructor({ world, variables, routingPlanner, assignmentUtils, etaEstimator, debug = true }) {
    this._world = world;
    this._variables = variables;
    this._routingPlanner = routingPlanner;
    this._utils = assignmentUtils;
    this._etaEstimator = etaEstimator;
    this._debug = debug;
  }

  update({ world, variables, routingPlanner, assignmentUtils, etaEstimator, debug }) {
    if (world) this._world = world;
    if (variables) this._variables = variables;
    if (routingPlanner) this._routingPlanner = routingPlanner;
    if (assignmentUtils) this._utils = assignmentUtils;
    if (etaEstimator) this._etaEstimator = etaEstimator;
    if (typeof debug === 'boolean') this._debug = debug;
  }

  _log(tag, data = {}, level = 'log') {
    if (!this._debug) return;
    console[level](`[Finder:${tag}]`, { ts: Date.now(), tag, ...data });
  }

  _isDriverConnected(driver) {
    return !(driver?.disconnected === true || driver?.connected === false);
  }

  _hasValidPos(pos) {
    return Number.isFinite(pos?.lat) && Number.isFinite(pos?.lng);
  }

  _getMaxPickupRadiusMeters() {
    const radiusKm =
      this._world?.params?.max_pickup_radius_km ??
      this._variables?.max_pickup_radius_km ??
      this._variables?.MAX_PICKUP_RADIUS_KM ??
      5;

    return radiusKm * 1000;
  }

  _estimateTravelTime(fromPos, toPos, driver = null, simTime = 0, traceId = null) {
    const duration_s = this._etaEstimator.estimate(fromPos, toPos, driver, simTime);
    this._log('eta', { traceId, duration_s, fromPos, toPos });
    return duration_s;
  }

  _getClosestViableStop(driver, restaurantPos, maxPickupRadiusM, traceId) {
    const candidates = [];
    const driverDist = haversineMeters(driver.pos, restaurantPos);

    if (driverDist < maxPickupRadiusM) {
      candidates.push({ type: 'driver', orderId: null, pos: { ...driver.pos }, distToRestaurant: driverDist });
    }

    const stops = this._routingPlanner.buildStops(driver, this._world);

    for (let i = 0; i < stops.length; i++) {
      const stop = stops[i];
      const dist = haversineMeters(stop.pos, restaurantPos);
      if (dist >= maxPickupRadiusM) continue;
      candidates.push({
        type: stop.type,
        orderId: stop.orderId ?? null,
        pos: { ...stop.pos },
        routeIndex: i,
        distToRestaurant: dist,
      });
    }

    if (candidates.length === 0) {
      this._log('discard', { traceId, driver: driver.name, reason: 'no_viable_stop' });
      return null;
    }

    candidates.sort((a, b) => a.distToRestaurant - b.distToRestaurant);
    return candidates[0];
  }

  _approximateCandidateScore(driver, viableStop, restaurant, customer, simTime) {
    const activeOrders = driver.orders?.length ?? 0;
    const loadPenalty = activeOrders * 180;
    const etaToRestaurant = this._estimateTravelTime(viableStop.pos, restaurant.pos, driver, simTime);
    const etaRestaurantToCustomer = this._estimateTravelTime(restaurant.pos, customer.pos, driver, simTime);
    const totalEta = etaToRestaurant + etaRestaurantToCustomer;
    return totalEta + loadPenalty;
  }

  async _estimateEtaToViableStop(driver, viableStop, traceId, simTime) {
    if (!viableStop || viableStop.type === 'driver') return 0;

    const stops = this._routingPlanner.buildStops(driver, this._world);
    const segmentPromises = stops.map((stop, i) => {
      const fromPos = i === 0 ? driver.pos : stops[i - 1].pos;
      return this._estimateTravelTime(fromPos, stop.pos, driver, simTime, traceId);
    });
    const segmentTimes = await Promise.all(segmentPromises);

    let eta = 0;
    for (let i = 0; i < stops.length; i++) {
      eta += segmentTimes[i];
      const stop = stops[i];
      const match =
        (Number.isFinite(viableStop.routeIndex) && viableStop.routeIndex === i) ||
        (stop.type === viableStop.type && (stop.orderId ?? null) === (viableStop.orderId ?? null));
      if (match) return eta;
    }

    return 0;
  }

  async find(order, { restaurant, customer, simTime = 0 }) {
    const traceId = `order_${order.id}_${Date.now()}`;
    const maxPickupRadiusM = this._getMaxPickupRadiusMeters();
    const hardTopK = Math.max(1, this._world?.params?.assignment_hard_top_k ?? 5);

    const viableDrivers = Object.values(this._world.drivers)
      .map((driver) => {
        if (!this._isDriverConnected(driver) || !this._hasValidPos(driver?.pos)) return null;
        const activeOrders = driver.orders?.length ?? 0;
        const maxOrders = Number.isFinite(driver.max_orders) ? driver.max_orders : 1;
        const reserved = driver._reservedSlots ?? 0;

        if ((activeOrders + reserved) >= maxOrders) return null;

        const viableStop = this._getClosestViableStop(driver, restaurant.pos, maxPickupRadiusM, traceId);
        if (!viableStop) return null;

        const approxScore = this._approximateCandidateScore(driver, viableStop, restaurant, customer, simTime);
        return { driver, viableStop, approxScore };
      })
      .filter(Boolean)
      .sort((a, b) => a.approxScore - b.approxScore);

    const reducedCandidates = viableDrivers.slice(0, hardTopK);

    const candidates = await Promise.all(
      reducedCandidates.map(async ({ driver, viableStop, approxScore }) => {
        const [etaToViableStop, etaViableToRestaurant, etaRestaurantToCustomer] = await Promise.all([
          this._estimateEtaToViableStop(driver, viableStop, traceId, simTime),
          this._estimateTravelTime(viableStop.pos, restaurant.pos, driver, simTime, traceId),
          this._estimateTravelTime(restaurant.pos, customer.pos, driver, simTime, traceId),
        ]);

        const etaToRestaurant = etaToViableStop + etaViableToRestaurant;
        const etaCandidate = etaToRestaurant + etaRestaurantToCustomer;

        return {
          driver,
          viableStop,
          approxScore,
          etaToRestaurant,
          etaCandidate,
          etaTotalPrelim: etaToRestaurant,
        };
      })
    );

    candidates.sort((a, b) => a.etaTotalPrelim - b.etaTotalPrelim);

    return {
      viableDrivers,
      candidates,
      topDrivers: candidates,
      traceId,
    };
  }
}
