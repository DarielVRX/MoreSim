import { fetchOSRMRoute } from './MovementEngine.js';
import { haversineMeters } from './GraphCache.js';

export class AssignmentCandidateFinder {
  constructor({ world, variables, routingPlanner, assignmentUtils }) {
    this._world = world;
    this._variables = variables;
    this._routingPlanner = routingPlanner;
    this._utils = assignmentUtils;
  }

  update({ world, variables, routingPlanner, assignmentUtils }) {
    if (world) this._world = world;
    if (variables) this._variables = variables;
    if (routingPlanner) this._routingPlanner = routingPlanner;
    if (assignmentUtils) this._utils = assignmentUtils;
  }

  _isDriverConnected(driver) {
    if (driver?.disconnected === true) return false;
    if (driver?.connected === false) return false;
    return true;
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

  async _estimateTravelTime(fromPos, toPos, driver = null) {
    try {
      const { duration_s } = await fetchOSRMRoute(fromPos, toPos);
      if (Number.isFinite(duration_s)) return duration_s;
    } catch {
      // fallback below
    }

    const speedMs = this._utils.getSpeedMs(driver);
    return haversineMeters(fromPos, toPos) / speedMs;
  }

  _getClosestViableStop(driver, restaurantPos, maxPickupRadiusM) {
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

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.distToRestaurant - b.distToRestaurant);
    return candidates[0];
  }

  async _estimateEtaToViableStop(driver, viableStop) {
    if (!viableStop || viableStop.type === 'driver') return 0;

    const stops = this._routingPlanner.buildStops(driver, this._world);
    let eta = 0;
    let currentPos = driver.pos;

    for (let i = 0; i < stops.length; i++) {
      const stop = stops[i];
      eta += await this._estimateTravelTime(currentPos, stop.pos, driver);
      const indexMatch = Number.isFinite(viableStop.routeIndex) && viableStop.routeIndex === i;
      if (indexMatch || (stop.type === viableStop.type && (stop.orderId ?? null) === (viableStop.orderId ?? null))) {
        return eta;
      }
      currentPos = stop.pos;
    }

    return 0;
  }

  async find(order, { restaurant, customer }) {
    const maxPickupRadiusM = this._getMaxPickupRadiusMeters();
    const drivers = Object.values(this._world.drivers);

    const viableDrivers = drivers
      .map((driver) => {
        if (!this._isDriverConnected(driver)) return null;
        if (!this._hasValidPos(driver?.pos)) return null;

        const activeOrders = Array.isArray(driver.orders) ? driver.orders.length : 0;
        const maxOrders = Number.isFinite(driver.max_orders) ? driver.max_orders : 1;
        if (activeOrders >= maxOrders) return null;

        const viableStop = this._getClosestViableStop(driver, restaurant.pos, maxPickupRadiusM);
        if (!viableStop) return null;

        driver._viableStop = {
          pos: viableStop.pos,
          type: viableStop.type,
          orderId: viableStop.orderId ?? null,
          routeIndex: viableStop.routeIndex ?? null,
        };

        return { driver, viableStop };
      })
      .filter(Boolean);

    const etaRestaurantToCustomer = await this._estimateTravelTime(restaurant.pos, customer.pos);

    const candidates = await Promise.all(viableDrivers.map(async ({ driver, viableStop }) => {
      const etaToViableStop = await this._estimateEtaToViableStop(driver, viableStop);
      const etaViableToRestaurant = await this._estimateTravelTime(viableStop.pos, restaurant.pos, driver);
      const etaToRestaurant = etaToViableStop + etaViableToRestaurant;
      const etaCandidate = etaToRestaurant + etaRestaurantToCustomer;

      return {
        driver,
        viableStop,
        etaToRestaurant,
        etaCandidate,
        etaTotalPrelim: etaToRestaurant,
      };
    }));

    candidates.sort((a, b) => a.etaTotalPrelim - b.etaTotalPrelim);

    return {
      viableDrivers,
      candidates,
      topDrivers: candidates.slice(0, 10),
      estimateTravelTime: this._estimateTravelTime.bind(this),
      etaRestaurantToCustomer,
    };
  }
}
