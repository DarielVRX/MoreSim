import { haversineMeters } from './GraphCache.js';

export class RoutingPlanner {
  constructor({ world, movementEngine, onEvent, getSimTime, debug = true }) {
    this._world = world;
    this._movement = movementEngine;
    this._onEvent = onEvent ?? (() => {});
    this._getSimTime = getSimTime ?? (() => 0);
    this._debug = debug;
  }

  updateWorld(world) {
    this._world = world;
  }

  // ─────────────────────────────────────────────
  // LOGGER CENTRAL
  // ─────────────────────────────────────────────
  _log(tag, data = {}, level = 'log') {
    if (!this._debug) return;

    console[level](`[Planner:${tag}]`, {
      ts: Date.now(),
                   tag,
                   ...data,
    });
  }

  // ─────────────────────────────────────────────
  // BUILD STOPS
  // ─────────────────────────────────────────────
  buildStops(driver, world = this._world) {
    const stops = [];
    const { orders, restaurants, customers } = world;

    for (const orderId of driver.orders ?? []) {
      const order = orders[orderId];
      if (!order) continue;

      if (order.status === 'assigned') {
        const restaurant = restaurants[order.restaurant_id];
        if (!restaurant?.pos) continue;

        stops.push({
          type: 'pickup',
          orderId: order.id,
          pos: restaurant.pos,
        });
      }

      if (order.status === 'on_the_way') {
        const customer = customers[order.customer_id];
        if (!customer?.pos) continue;

        stops.push({
          type: 'delivery',
          orderId: order.id,
          pos: customer.pos,
        });
      }
    }

    return stops;
  }

  replan(driver) {
    return this.planNextStop(driver, this._world, 'replan');
  }

  // ─────────────────────────────────────────────
  // MAIN PLANNER
  // ─────────────────────────────────────────────
  async planNextStop(driver, world = this._world, reason = 'plan') {
    const simTime = this._getSimTime();
    const startedAtMs = Date.now();
    const traceId = `drv_${driver.id}_${simTime}`;

    const stops = this.buildStops(driver, world);

    this._log('start', {
      traceId,
      driver: driver.name,
      status: driver.status,
      orders: driver.orders,
      stopsCount: stops.length,
      reason,
    });

    // 🔥 BLOQUEO DE REPLAN (CRÍTICO)
    const isMoving =
    driver.path?.length > 0 &&
    driver.path_index < driver.path.length - 1;

    if (isMoving && reason !== 'replan') {
      this._log('skip_replan_active_route', {
        traceId,
        driver: driver.name,
        pathIndex: driver.path_index,
        pathLength: driver.path.length,
        reason,
      });
      return null;
    }

    if (stops.length === 0) {
      this._log('idle', { traceId, driver: driver.name });

      driver.status = 'idle';
      driver._arrival_type = null;
      driver.current_restaurant_id = null;

      this._onEvent({
        time: simTime,
        type: 'routing_idle',
        message: `🧭 ${driver.name} sin stops activos → idle`,
        driverId: driver.id,
        reason,
      });

      return null;
    }

    // ─── URGENCIA ───
    const urgentDeliveries = this._findUrgentDeliveries(driver, stops, world, traceId);

    let nextStop;
    let decision;

    if (urgentDeliveries.length > 0) {
      decision = 'urgent_delivery';
      nextStop = this._closestStop(driver.pos, urgentDeliveries);
    } else {
      decision = 'nearest_stop';
      nextStop = this._closestStop(driver.pos, stops);
    }

    if (!nextStop) {
      this._log('no_stop', { traceId });
      driver.status = 'idle';
      return null;
    }

    const distToStop = haversineMeters(driver.pos, nextStop.pos);

    this._log('decision', {
      traceId,
      driver: driver.name,
      decision,
      nextStop,
      dist_m: distToStop.toFixed(1),
              urgentCount: urgentDeliveries.length,
    });

    // ─── STATUS ───
    if (nextStop.type === 'pickup') {
      const order = world.orders[nextStop.orderId];
      driver.status = 'moving_to_pickup';
      driver._arrival_type = 'at_restaurant';
      driver.current_restaurant_id = order?.restaurant_id ?? null;
    } else {
      driver.status = 'moving_to_delivery';
      driver._arrival_type = 'at_customer';
      driver.current_restaurant_id = null;
    }

    // ─── YA ESTÁ EN STOP ───
    if (distToStop < 5) {
      this._log('already_at_stop', {
        traceId,
        driver: driver.name,
        dist_m: distToStop,
      });

      driver.status =
      nextStop.type === 'pickup'
      ? 'waiting_at_restaurant'
      : 'waiting_at_customer';

      return nextStop;
    }

    // ─── MOVEMENT ───
    let routeInfo = null;

    const prevPos = { ...driver.pos };
    const prevIndex = driver.path_index ?? 0;

    try {
      routeInfo = await this._movement.setOrderRoute(
        driver,
        driver.pos,
        nextStop.pos
      );
      // NO reiniciar progreso si ya estaba moviéndose
      if (driver.path && driver.path.length > 0) {
        driver.path_index = 0; // base

        // opcional: buscar punto más cercano en nueva ruta
        let bestIdx = 0;
        let bestDist = Infinity;

        for (let i = 0; i < driver.path.length; i++) {
          const dist = haversineMeters(prevPos, driver.path[i]);
          if (dist < bestDist) {
            bestDist = dist;
            bestIdx = i;
          }
        }

        driver.path_index = bestIdx;
      }
    } catch (e) {
      this._log('movement_error', {
        traceId,
        error: e.message,
      }, 'error');
    }

    // 🔥 VALIDACIÓN CRÍTICA
    const pathLen = driver.path?.length ?? 0;

    this._log('movement_result', {
      traceId,
      driver: driver.name,
      pathLength: pathLen,
      routeInfo,
    });

    if (pathLen === 0) {
      this._log('CRITICAL_NO_PATH', {
        traceId,
        driver: driver.name,
        issue: 'driver_has_no_path_after_routing',
      }, 'error');
    }

    // ─── ROUTE PLAN ───
    driver._route_plan = {
      started_at: simTime,
      stop_type: nextStop.type,
      order_id: nextStop.orderId,
      expected_duration_s: routeInfo?.duration_s ?? null,
      expected_distance_m: routeInfo?.distance_m ?? null,
      decision,
      reason,
    };

    this._log('route_plan', {
      traceId,
      driver: driver.name,
      routePlan: driver._route_plan,
      planning_ms: Date.now() - startedAtMs,
    });

    this._onEvent({
      time: simTime,
      type: 'routing_decision',
      message:
      `🧠 ${driver.name} → ${nextStop.type} ${nextStop.orderId} ` +
      `(decision=${decision})`,
                  driverId: driver.id,
                  orderId: nextStop.orderId,
                  decision,
                  reason,
                  planning_elapsed_ms: Date.now() - startedAtMs,
                  expected_duration_s: routeInfo?.duration_s ?? null,
    });

    return nextStop;
  }

  // ─────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────
  _closestStop(fromPos, stops) {
    let best = null;
    let bestDist = Infinity;

    for (const stop of stops) {
      const dist = haversineMeters(fromPos, stop.pos);
      if (dist < bestDist) {
        best = stop;
        bestDist = dist;
      }
    }

    return best;
  }

  _findUrgentDeliveries(driver, stops, world, traceId) {
    const simTime = this._getSimTime();
    const { orders, customers } = world;

    const deliveryStops = stops.filter(s => s.type === 'delivery');
    if (deliveryStops.length === 0) return [];

    const speedMs = ((driver.speed_kmh ?? 30) * 1000) / 3600;

    return deliveryStops.filter((stop) => {
      const order = orders[stop.orderId];
      const customer = customers[order?.customer_id];
      if (!order || !customer) return false;

      const maxDeliveryTime =
      customer.max_delivery_time_s ??
      world.params?.max_delivery_time_s ??
      1800;

      const elapsed = Math.max(0, simTime - (order.picked_up_at ?? simTime));
      const remaining = maxDeliveryTime - elapsed;

      const etaDirect = haversineMeters(driver.pos, customer.pos) / speedMs;

      const isUrgent = etaDirect >= remaining;

      if (isUrgent) {
        this._log('urgent_detected', {
          traceId,
          order: order.id,
          remaining_s: remaining.toFixed(1),
                  etaDirect_s: etaDirect.toFixed(1),
        }, 'warn');
      }

      return isUrgent;
    });
  }
}
