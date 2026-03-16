// src/engine/RoutingPlanner.js

import { haversineMeters } from './GraphCache.js';

export class RoutingPlanner {
  constructor({ world, movementEngine, onEvent, getSimTime }) {
    this._world = world;
    this._movement = movementEngine;
    this._onEvent = onEvent ?? (() => {});
    this._getSimTime = getSimTime ?? (() => 0);
  }

  updateWorld(world) {
    this._world = world;
  }

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

  async planNextStop(driver, world = this._world, reason = 'plan') {
    const simTime = this._getSimTime();
    const startedAtMs = Date.now();
    const stops = this.buildStops(driver, world);

    if (stops.length === 0) {
      driver.status = 'idle';
      driver._arrival_type = null;
      driver.current_restaurant_id = null;

      this._onEvent({
        time: simTime,
        type: 'routing_idle',
        message: `🧭 ${driver.name} sin stops activos → estado idle`,
        driverId: driver.id,
        reason,
      });

      return null;
    }

    const urgentDeliveries = this._findUrgentDeliveries(driver, stops, world);

    let nextStop;
    let decision;
    if (urgentDeliveries.length > 0) {
      nextStop = this._closestStop(driver.pos, urgentDeliveries);
      decision = 'urgent_delivery';
    } else {
      nextStop = this._closestStop(driver.pos, stops);
      decision = 'nearest_stop';
    }

    if (!nextStop) {
      driver.status = 'idle';
      driver._arrival_type = null;
      driver.current_restaurant_id = null;
      return null;
    }

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

    const distToStop = haversineMeters(driver.pos, nextStop.pos);

    if (distToStop < 5) { // metros
      if (nextStop.type === 'pickup') {
        driver.status = 'waiting_at_restaurant';
        driver._arrival_type = 'at_restaurant';
      } else {
        driver.status = 'waiting_at_customer';
        driver._arrival_type = 'at_customer';
      }

      return nextStop;
    }

    const routeInfo = await this._movement.setOrderRoute(driver, driver.pos, nextStop.pos);

    driver._route_plan = {
      started_at: simTime,
      stop_type: nextStop.type,
      order_id: nextStop.orderId,
      expected_duration_s: routeInfo?.duration_s ?? null,
      expected_distance_m: routeInfo?.distance_m ?? null,
      decision,
      reason,
    };

    this._onEvent({
      time: simTime,
      type: 'routing_decision',
      message:
        `🧠 ${driver.name} decidió ${nextStop.type} ${nextStop.orderId} ` +
        `(criterio=${decision}, urgent=${urgentDeliveries.length}, stops=${stops.length})`,
      driverId: driver.id,
      orderId: nextStop.orderId,
      decision,
      reason,
      planning_elapsed_ms: Date.now() - startedAtMs,
      expected_duration_s: routeInfo?.duration_s ?? null,
      expected_distance_m: routeInfo?.distance_m ?? null,
      urgent_candidates: urgentDeliveries.map(s => s.orderId),
    });

    return nextStop;
  }

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

  _findUrgentDeliveries(driver, stops, world) {
    const simTime = this._getSimTime();
    const { orders, customers } = world;

    const deliveryStops = stops.filter(s => s.type === 'delivery');
    if (deliveryStops.length === 0) return [];

    const speedMs = ((driver.speed_kmh ?? 30) * 1000) / 3600;

    return deliveryStops.filter((stop) => {
      const order = orders[stop.orderId];
      const customer = customers[order?.customer_id];
      if (!order || !customer || !Number.isFinite(speedMs) || speedMs <= 0) {
        return false;
      }

      const maxDeliveryTime =
        customer.max_delivery_time_s ??
        world.params?.max_delivery_time_s ??
        1800;

      const elapsed = Math.max(0, simTime - (order.picked_up_at ?? simTime));
      const remaining = maxDeliveryTime - elapsed;

      const etaDirect = haversineMeters(driver.pos, customer.pos) / speedMs;

      const otherStops = stops.filter(s => s.orderId !== stop.orderId);
      const nearestStop = this._closestStop(driver.pos, otherStops);
      let etaDetour = etaDirect;

      if (nearestStop) {
        const detourDist =
          haversineMeters(driver.pos, nearestStop.pos) +
          haversineMeters(nearestStop.pos, customer.pos);
        etaDetour = detourDist / speedMs;
      }

      return etaDirect >= remaining || etaDetour >= remaining;
    });
  }
}
