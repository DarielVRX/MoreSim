import { fetchOSRMRoute } from './MovementEngine.js';
import { haversineMeters } from './GraphCache.js';

export class AssignmentCandidateFinder {
  constructor({ world, variables, routingPlanner, assignmentUtils, debug = true }) {
    this._world = world;
    this._variables = variables;
    this._routingPlanner = routingPlanner;
    this._utils = assignmentUtils;
    this._debug = debug;
  }

  update({ world, variables, routingPlanner, assignmentUtils, debug }) {
    if (world) this._world = world;
    if (variables) this._variables = variables;
    if (routingPlanner) this._routingPlanner = routingPlanner;
    if (assignmentUtils) this._utils = assignmentUtils;
    if (typeof debug === 'boolean') this._debug = debug;
  }

  // ─────────────────────────────────────────────
  // LOGGER CENTRAL
  // ─────────────────────────────────────────────
  _log(tag, data = {}, level = 'log') {
    if (!this._debug) return;

    const payload = {
      ts: Date.now(),
      tag,
      ...data,
    };

    console[level](`[Finder:${tag}]`, payload);
  }

  // ─────────────────────────────────────────────
  // VALIDACIONES
  // ─────────────────────────────────────────────
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

  // ─────────────────────────────────────────────
  // ETA
  // ─────────────────────────────────────────────
  async _estimateTravelTime(fromPos, toPos, driver = null, useOSRM = false, traceId = null) {
    if (useOSRM) {
      try {
        const { duration_s } = await fetchOSRMRoute(fromPos, toPos);

        if (Number.isFinite(duration_s)) {
          this._log('osrm', {
            traceId,
            from: fromPos,
            to: toPos,
            duration_s,
          });
          return duration_s;
        }

      } catch (e) {
        this._log('fallback', {
          traceId,
          reason: 'osrm_failed',
          error: e.message,
        }, 'warn');
      }
    }

    const speedMs = this._utils.getSpeedMs(driver);
    const dist = haversineMeters(fromPos, toPos);
    const time = dist / speedMs;

    this._log('haversine', {
      traceId,
      from: fromPos,
      to: toPos,
      distance_m: dist.toFixed(1),
              time_s: time.toFixed(1),
    });

    return time;
  }

  // ─────────────────────────────────────────────
  // VIABLE STOP
  // ─────────────────────────────────────────────
  _getClosestViableStop(driver, restaurantPos, maxPickupRadiusM, traceId) {
    const candidates = [];
    const driverDist = haversineMeters(driver.pos, restaurantPos);

    if (driverDist < maxPickupRadiusM) {
      candidates.push({
        type: 'driver',
        orderId: null,
        pos: { ...driver.pos },
        distToRestaurant: driverDist,
      });
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
      this._log('discard', {
        traceId,
        driver: driver.name,
        reason: 'no_viable_stop',
        radius_m: maxPickupRadiusM,
      });
      return null;
    }

    candidates.sort((a, b) => a.distToRestaurant - b.distToRestaurant);

    const best = candidates[0];

    this._log('viable_stop', {
      traceId,
      driver: driver.name,
      type: best.type,
      orderId: best.orderId,
      dist_m: best.distToRestaurant.toFixed(1),
              routeIndex: best.routeIndex ?? null,
              totalCandidates: candidates.length,
    });

    return best;
  }

  async _estimateEtaToViableStop(driver, viableStop, traceId) {
    if (!viableStop || viableStop.type === 'driver') return 0;

    const stops = this._routingPlanner.buildStops(driver, this._world);

    let eta = 0;
    let currentPos = driver.pos;

    for (let i = 0; i < stops.length; i++) {
      const stop = stops[i];

      const segmentTime =
      await this._estimateTravelTime(currentPos, stop.pos, driver, false, traceId);

      eta += segmentTime;

      const match =
      (Number.isFinite(viableStop.routeIndex) && viableStop.routeIndex === i) ||
      (stop.type === viableStop.type && (stop.orderId ?? null) === (viableStop.orderId ?? null));

      if (match) {
        this._log('eta_to_viable', {
          traceId,
          driver: driver.name,
          eta_s: eta.toFixed(1),
                  reachedStop: stop,
        });

        return eta;
      }

      currentPos = stop.pos;
    }

    return 0;
  }

  // ─────────────────────────────────────────────
  // MAIN
  // ─────────────────────────────────────────────
  async find(order, { restaurant, customer }) {

    const traceId = `order_${order.id}_${Date.now()}`;

    const maxPickupRadiusM = this._getMaxPickupRadiusMeters();
    const drivers = Object.values(this._world.drivers);

    this._log('start', {
      traceId,
      order: order.id,
      drivers: drivers.length,
      radius_m: maxPickupRadiusM,
    });

    this._log('drivers_deep_inspect', {
      traceId,
      driversRaw: this._world.drivers,
      keys: Object.keys(this._world.drivers || {}),
              type: typeof this._world.drivers,
    });

    // ─── Estadísticas de descarte ───
    const discardStats = {
      not_connected: 0,
      invalid_position: 0,
      max_capacity: 0,
      no_viable_stop: 0,
    };

    const viableDrivers = drivers
    .map((driver) => {

      if (!this._isDriverConnected(driver)) {
        discardStats.not_connected++;
        this._log('discard', { traceId, driver: driver.name, reason: 'not_connected' });
        return null;
      }

      if (!this._hasValidPos(driver?.pos)) {
        discardStats.invalid_position++;
        this._log('discard', { traceId, driver: driver.name, reason: 'invalid_position' });
        return null;
      }

      const activeOrders = driver.orders?.length ?? 0;
      const maxOrders = Number.isFinite(driver.max_orders) ? driver.max_orders : 1;

      if (activeOrders >= maxOrders) {
        discardStats.max_capacity++;
        this._log('discard', {
          traceId,
          driver: driver.name,
          reason: 'max_capacity',
          activeOrders,
          maxOrders,
        });
        return null;
      }

      const viableStop =
      this._getClosestViableStop(driver, restaurant.pos, maxPickupRadiusM, traceId);

      if (!viableStop) {
        discardStats.no_viable_stop++;
        return null;
      }

      return { driver, viableStop };
    })
    .filter(Boolean);

    // ─── RESUMEN CLAVE ───
    this._log('discard_summary', {
      traceId,
      totalDrivers: drivers.length,
      viable: viableDrivers.length,
      discarded: drivers.length - viableDrivers.length,
      breakdown: discardStats,
    });

    if (viableDrivers.length === 0) {
      return {
        viableDrivers: [],
        candidates: [],
        topDrivers: [],
        rejectedSummary: discardStats,
      };
    }

    const etaRestaurantToCustomer =
    await this._estimateTravelTime(
      restaurant.pos,
      customer.pos,
      null,
      true,
      traceId
    );

    const candidates = await Promise.all(
      viableDrivers.map(async ({ driver, viableStop }) => {

        const etaToViableStop =
        await this._estimateEtaToViableStop(driver, viableStop, traceId);

        const etaViableToRestaurant =
        await this._estimateTravelTime(
          viableStop.pos,
          restaurant.pos,
          driver,
          true,
          traceId
        );

        const etaToRestaurant =
        etaToViableStop + etaViableToRestaurant;

        const etaCandidate =
        etaToRestaurant + etaRestaurantToCustomer;

        this._log('candidate_eta', {
          traceId,
          driver: driver.name,
          etaToRestaurant: etaToRestaurant.toFixed(1),
                  total: etaCandidate.toFixed(1),
        });

        return {
          driver,
          viableStop,
          etaToRestaurant,
          etaCandidate,
          etaTotalPrelim: etaToRestaurant,
        };
      })
    );

    // ─── DISTRIBUCIÓN ETA ───
    const etaValues = candidates.map(c => c.etaCandidate);

    this._log('eta_distribution', {
      traceId,
      min: Math.min(...etaValues).toFixed(1),
              max: Math.max(...etaValues).toFixed(1),
              avg: (etaValues.reduce((a, b) => a + b, 0) / etaValues.length).toFixed(1),
    });

    candidates.sort((a, b) => a.etaTotalPrelim - b.etaTotalPrelim);

    this._log('ranking_top5', {
      traceId,
      top: candidates.slice(0, 5).map(c => ({
        driver: c.driver.name,
        eta: c.etaCandidate.toFixed(1),
      })),
    });

    return {
      viableDrivers,
      candidates,
      topDrivers: candidates.slice(0, 10),
      etaRestaurantToCustomer,
      traceId,
    };
  }
}
