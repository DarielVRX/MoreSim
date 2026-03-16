// src/engine/AssignmentEngine.js

import { fetchOSRMRoute }   from './MovementEngine.js';
import { haversineMeters }  from './GraphCache.js';
import { RoutingPlanner }   from './RoutingPlanner.js';

export class AssignmentEngine {

  constructor({ variables, world, movementEngine, onEvent }) {
    this._variables      = variables;
    this._world          = world;
    this._movement       = movementEngine;
    this._onEvent        = onEvent ?? (() => {});
    this._assigning      = new Set();
    this._simTime        = 0;
    this._routingPlanner = new RoutingPlanner({
      world: this._world,
      movementEngine: this._movement,
      onEvent: this._onEvent,
      getSimTime: () => this._simTime,
    });
  }

  updateVariables(vars) {
    this._variables = vars;
  }

  // ─────────────────────────────────────────────────────────────
  // TICK PRINCIPAL
  // SOLO gestiona cocina y pickups (NO asignaciones)
  // ─────────────────────────────────────────────────────────────
  tick(dtSim, simTime) {
    this._simTime = simTime;
    this._routingPlanner.updateWorld(this._world);

    const { orders, restaurants } = this._world;

    // ─── 1. Timers de cocina ───────────────────────────────────
    for (const order of Object.values(orders)) {

      if (order.status !== 'assigned') continue;
      if (order.kitchen_status !== 'preparing') continue;

      order._kitchen_elapsed = (order._kitchen_elapsed ?? 0) + dtSim;

      const restaurant = restaurants[order.restaurant_id];

      if (order._kitchen_elapsed >= (restaurant?.prep_time_s ?? 600)) {

        order.kitchen_status = 'ready';
        order.kitchen_ready_at = simTime;

        this._onEvent({
          time: simTime,
          type: 'kitchen_ready',
          message: `🍳 ${restaurant?.name ?? order.restaurant_id} — Pedido ${order.id} listo para retiro`,
          orderId: order.id
        });
      }
    }

  }

  // ─────────────────────────────────────────────────────────────
  // EVENTO: PEDIDO CREADO
  // ─────────────────────────────────────────────────────────────
  handleOrderCreated(orderId, simTime) {

    const order = this._world.orders[orderId];
    if (!order) return;

    this._tryAssign(order, simTime);
  }

  // ─────────────────────────────────────────────────────────────
  // EVENTO: DRIVER LIBERA CAPACIDAD
  // ─────────────────────────────────────────────────────────────
  handleDriverLoadReduced(driverId, simTime) {

    const { orders } = this._world;

    const queued = Object.values(orders)
    .filter(o => o.status === 'queued' && o.triggered);

    if (queued.length === 0) return;

    queued.sort((a,b)=> (a.created_at ?? 0) - (b.created_at ?? 0));

    this._tryAssign(queued[0], simTime);
  }

  // ─────────────────────────────────────────────────────────────
  // INTENTO CONTROLADO DE ASIGNACIÓN
  // ─────────────────────────────────────────────────────────────
  _tryAssign(order, simTime) {

    if (order.status !== 'queued') return;
    if (!order.triggered) return;

    if (this._assigning.has(order.id)) return;

    this._assigning.add(order.id);

    this._assignOrder(order, simTime)
    .finally(() => this._assigning.delete(order.id));
  }

  // ─────────────────────────────────────────────────────────────
  // ASIGNACIÓN PRINCIPAL
  // ─────────────────────────────────────────────────────────────
  async _assignOrder(order, simTime) {
    const startedAtMs = Date.now();

    const { drivers, restaurants, customers } = this._world;

    const restaurant = restaurants[order.restaurant_id];
    const customer   = customers[order.customer_id];

    if (!restaurant || !customer) return;

    if (!Number.isFinite(restaurant?.pos?.lat)) return;
    if (!Number.isFinite(customer?.pos?.lat)) return;

    // ─── Restricción distancia cliente ────────────────────────

    const distKm =
    haversineMeters(restaurant.pos, customer.pos) / 1000;

    if (customer.max_distance_km > 0 && distKm > customer.max_distance_km) {

      this._onEvent({
        time: simTime,
        type: 'no_driver',
        message: `⛔ Pedido ${order.id} cancelado — distancia ${distKm.toFixed(1)} km supera máximo`,
                    orderId: order.id
      });

      order.status = 'cancelled';
      return;
    }

    // ─── Drivers disponibles (hard filters) ───────────────────

    const maxPickupRadiusM = this._getMaxPickupRadiusMeters();

    const viableDrivers = Object.values(drivers)
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

        return {
          driver,
          viableStop,
        };
      })
      .filter(Boolean);

    if (viableDrivers.length === 0) {

      this._onEvent({
        time: simTime,
        type: 'no_driver',
        message: `⚠️ Pedido ${order.id} sin driver disponible`,
        orderId: order.id
      });

      return;
    }

    const etaRestaurantToCustomer = await this._estimateTravelTime(restaurant.pos, customer.pos, null);

    // ─── ETA preliminar usando viable stop ────────────────────

    const candidates = await Promise.all(viableDrivers.map(async ({ driver, viableStop }) => {
      const etaToViableStop = await this._estimateEtaToViableStop(driver, viableStop);
      const etaViableToRestaurant = await this._estimateTravelTime(viableStop.pos, restaurant.pos, driver);
      const etaToRestaurant = etaToViableStop + etaViableToRestaurant;
      const etaCandidate = etaToRestaurant + etaRestaurantToCustomer;
      const maxDeliveryTime = this._getDeliverySla(customer);

      return {
        driver,
        viableStop,
        etaToRestaurant,
        etaCandidate,
        etaTotalPrelim: etaToRestaurant,
        slaValid: etaCandidate <= maxDeliveryTime,
      };
    }));

    candidates.sort((a, b) => a.etaTotalPrelim - b.etaTotalPrelim);

    const topDrivers = candidates.slice(0, 10);
    if (topDrivers.length === 0) return;

    // ─── Simulación de ruta completa para TOP_K ───────────────

    const evaluated = await Promise.all(topDrivers.map(async (candidate) => {
      const simulation = await this._simulateDriverWithOrder({
        driver: candidate.driver,
        order,
        viableStop: candidate.viableStop,
        simTime,
      });

      return {
        ...candidate,
        ...simulation,
      };
    }));

    const validEvaluated = evaluated.filter((item) => item.valid);

    const winnerData = (validEvaluated.length > 0 ? validEvaluated : evaluated)
      .sort((a, b) => a.etaToNewCustomer - b.etaToNewCustomer)[0];

    if (!winnerData) return;
    const winner = winnerData.driver;

    order.assignment_score = winnerData.etaToNewCustomer;

    // ─── Mutar pedido ─────────────────────────────────────────

    order.status = 'assigned';
    order.driver_id = winner.id;
    order.assigned_at = simTime;
    order.score_breakdown = evaluated.map((item) => ({
      driver: item.driver,
      eta_total_prelim_s: item.etaTotalPrelim,
      eta_candidate_s: item.etaCandidate,
      eta_new_customer_s: item.etaToNewCustomer,
      sla_fast_valid: item.slaValid,
      sla_route_valid: item.valid,
      sla_breaches: item.slaBreaches,
    }));
    order._kitchen_elapsed = 0;

    // ─── Distancia ruta ───────────────────────────────────────

    try {

      const { distance_m } =
      await fetchOSRMRoute(restaurant.pos, customer.pos);

      order.route_distance_km = distance_m / 1000;

    } catch {

      order.route_distance_km =
      haversineMeters(restaurant.pos, customer.pos) / 1000;
    }

    // ─── Mutar driver ─────────────────────────────────────────

    if (!winner.orders.includes(order.id)) {
      winner.orders.push(order.id);
    }

    winner.orders.sort((a, b) => {
      const oa = this._world.orders[a];
      const ob = this._world.orders[b];

      return (ob.assignment_score ?? 0) - (oa.assignment_score ?? 0);
    });

    this._onEvent({
      time: simTime,
      type: 'assigned',
      message: `📦 Pedido ${order.id} → ${winner.name}`,
      orderId: order.id,
      driverId: winner.id,
      results: order.score_breakdown,
    });

    this._onEvent({
      time: simTime,
      type: 'assignment_audit',
      message:
        `🧪 assign ${order.id}: viables=${viableDrivers.length}, ` +
        `top10=${topDrivers.length}, ganador=${winner.name}, ` +
        `eta_nuevo=${order.assignment_score.toFixed(1)}s`,
      orderId: order.id,
      driverId: winner.id,
      elapsed_ms: Date.now() - startedAtMs,
      winner_eta_to_restaurant_s: winnerData.etaToRestaurant ?? null,
    });

    await this._routingPlanner.replan(winner);
  }

  // ─────────────────────────────────────────────────────────────
  // DRIVER ARRIVED
  // ─────────────────────────────────────────────────────────────
  handleDriverArrived(driver, type, simTime) {
    this._simTime = simTime;
    this._routingPlanner.updateWorld(this._world);

    const { orders, restaurants, customers } = this._world;
    if (type === 'at_restaurant') {

      driver.status = 'waiting_at_restaurant';

      const restaurantId = driver.current_restaurant_id;
      const rest = restaurants[restaurantId];

      this._emitRouteAudit(driver, simTime, 'restaurant');

      const assignedAtRestaurant = driver.orders
      .map(id => orders[id])
      .filter(o =>
        o &&
        o.status === 'assigned' &&
        o.restaurant_id === restaurantId
      );

      const readyOrders = assignedAtRestaurant
      .filter(o => o.kitchen_status === 'ready');

      const preparingOrders = assignedAtRestaurant
      .filter(o => o.kitchen_status !== 'ready');

      if (readyOrders.length > 0) {
        this._onEvent({
          time: simTime,
          type: 'arrived_restaurant',
          message:
            `🏪 ${driver.name} llegó a ${rest?.name ?? 'comercio'} — ` +
            `${readyOrders.length} pedido(s) listos para retirar`,
          driverId: driver.id
        });
      } else {
        const nextPrep = preparingOrders
          .map(o => (rest?.prep_time_s ?? 600) - (o._kitchen_elapsed ?? 0))
          .filter(v => Number.isFinite(v))
          .reduce((min, v) => Math.min(min, v), Infinity);

        this._onEvent({
          time: simTime,
          type: 'arrived_restaurant',
          message:
            `🏪 ${driver.name} llegó a ${rest?.name ?? 'comercio'} — ` +
            `sin pedidos listos (${preparingOrders.length} preparando, ETA ${Number.isFinite(nextPrep) ? Math.max(0, nextPrep).toFixed(0) : '?'}s)`,
          driverId: driver.id
        });
      }

      for (const order of readyOrders) {
        order.status = 'on_the_way';
        order.picked_up_at = simTime;

        driver.orders.sort((a,b)=> {
          const oa = orders[a];
          const ob = orders[b];
          return (ob.assignment_score ?? 0) - (oa.assignment_score ?? 0);
        });

        this._onEvent({
          time: simTime,
          type: 'pickup',
          message: `📦 ${driver.name} retiró pedido ${order.id}`,
          orderId: order.id,
          driverId: driver.id,
        });
      }

      if (readyOrders.length > 0) {
        this._routingPlanner.planNextStop(driver, this._world, 'driver_arrived_restaurant');
      }
      return;
    }

    if (type === 'at_customer') {

      const order =
      driver.orders
      .map(id => orders[id])
      .find(o =>
      o?.status === 'on_the_way' &&
      haversineMeters(driver.pos, customers[o.customer_id].pos) < 25
      );

      if (!order) return;

      const orderId = order.id;

      order.status = 'delivered';
      order.delivered_at = simTime;
      driver._arrival_type = null;

      driver.orders =
      driver.orders.filter(id => id !== orderId);

      this._emitRouteAudit(driver, simTime, 'customer', order);

      this._onEvent({
        time: simTime,
        type: 'delivered',
        message: `✅ ${driver.name} entregó pedido ${order.id}`,
        orderId: order.id,
        driverId: driver.id
      });

      // liberar capacidad para asignaciones nuevas
      this.handleDriverLoadReduced(driver.id, simTime);

      this._routingPlanner.planNextStop(driver, this._world, 'driver_arrived_customer');
      return;
    }

    if (type === 'at_free_dest') {

      driver.status = 'waiting_at_restaurant';
      driver.idle_elapsed = 0;
    }
  }

  _emitRouteAudit(driver, simTime, destination, order = null) {
    const plan = driver._route_plan;
    if (!plan) return;

    const actualDuration = Math.max(0, simTime - (plan.started_at ?? simTime));
    const expectedDuration = plan.expected_duration_s;
    const delta = Number.isFinite(expectedDuration)
      ? actualDuration - expectedDuration
      : null;

    this._onEvent({
      time: simTime,
      type: 'route_audit',
      message:
        `⏱️ ${driver.name} ${destination} (${plan.stop_type}:${plan.order_id}) ` +
        `real=${actualDuration.toFixed(1)}s est=${Number.isFinite(expectedDuration) ? expectedDuration.toFixed(1) : 'n/a'}s`,
      driverId: driver.id,
      orderId: order?.id ?? plan.order_id,
      route_started_at: plan.started_at,
      route_finished_at: simTime,
      elapsed_s: actualDuration,
      expected_s: expectedDuration,
      delta_s: delta,
      decision: plan.decision,
      reason: plan.reason,
    });

    driver._route_plan = null;
  }

  _hasValidPos(pos) {
    return Number.isFinite(pos?.lat) && Number.isFinite(pos?.lng);
  }

  _isDriverConnected(driver) {
    if (driver?.disconnected === true) return false;
    if (driver?.connected === false) return false;
    return true;
  }

  _getMaxPickupRadiusMeters() {
    const radiusKm =
      this._world?.params?.max_pickup_radius_km ??
      this._variables?.max_pickup_radius_km ??
      this._variables?.MAX_PICKUP_RADIUS_KM ??
      5;

    return radiusKm * 1000;
  }

  _getDeliverySla(customer) {
    return customer?.max_delivery_time_s ?? this._world?.params?.max_delivery_time_s ?? 1800;
  }

  _estimateRemainingRouteEta(driver, simTime) {
    if (Number.isFinite(driver.remaining_route_eta)) return Math.max(0, driver.remaining_route_eta);
    if (Number.isFinite(driver.eta_sum)) return Math.max(0, driver.eta_sum);

    const expected = driver?._route_plan?.expected_duration_s;
    const started = driver?._route_plan?.started_at;
    if (Number.isFinite(expected) && Number.isFinite(started)) {
      return Math.max(0, expected - Math.max(0, simTime - started));
    }

    return 0;
  }

  _getSpeedMs(driver) {
    const speedKmh = Number.isFinite(driver?.speed_kmh) ? driver.speed_kmh : 30;
    return Math.max(1, (speedKmh * 1000) / 3600);
  }

  async _estimateTravelTime(fromPos, toPos, driver = null) {
    try {
      const { duration_s } = await fetchOSRMRoute(fromPos, toPos);
      if (Number.isFinite(duration_s)) return duration_s;
    } catch {
      // fallback below
    }

    const speedMs = this._getSpeedMs(driver);
    return haversineMeters(fromPos, toPos) / speedMs;
  }


  _isSameStop(a, b) {
    if (!a || !b) return false;
    return a.type === b.type && (a.orderId ?? null) === (b.orderId ?? null);
  }

  _getClosestViableStop(driver, restaurantPos, maxPickupRadiusM) {
    const candidates = [];

    const distDriver = haversineMeters(driver.pos, restaurantPos);
    if (distDriver < maxPickupRadiusM) {
      candidates.push({
        type: 'driver',
        orderId: null,
        pos: { ...driver.pos },
        distToRestaurant: distDriver,
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
      if (indexMatch || this._isSameStop(stop, viableStop)) {
        return eta;
      }
      currentPos = stop.pos;
    }

    return 0;
  }

  _buildSimulationState(driver, candidateOrderId, simTime) {
    const state = {};
    const orders = this._world.orders;

    for (const orderId of driver.orders ?? []) {
      const o = orders[orderId];
      if (!o) continue;

      state[orderId] = {
        orderId,
        status: o.status,
        pickedUpAt: o.picked_up_at,
      };
    }

    state[candidateOrderId] = {
      orderId: candidateOrderId,
      status: 'assigned',
      pickedUpAt: null,
      assignedAt: simTime,
    };

    return state;
  }

  _buildActiveStopsFromState(simState) {
    const stops = [];
    const { orders, restaurants, customers } = this._world;

    for (const orderState of Object.values(simState)) {
      const order = orders[orderState.orderId];
      if (!order) continue;

      if (orderState.status === 'assigned') {
        const restaurant = restaurants[order.restaurant_id];
        if (restaurant?.pos) {
          stops.push({
            type: 'pickup',
            orderId: order.id,
            pos: restaurant.pos,
          });
        }
      }

      if (orderState.status === 'on_the_way') {
        const customer = customers[order.customer_id];
        if (customer?.pos) {
          stops.push({
            type: 'delivery',
            orderId: order.id,
            pos: customer.pos,
          });
        }
      }
    }

    return stops;
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

  _findUrgentDeliveryStops(driver, currentPos, stops, simState, simNow) {
    const { orders, customers } = this._world;
    const speedMs = this._getSpeedMs(driver);
    const deliveries = stops.filter((s) => s.type === 'delivery');

    return deliveries.filter((deliveryStop) => {
      const order = orders[deliveryStop.orderId];
      const customer = customers[order?.customer_id];
      const state = simState[deliveryStop.orderId];
      if (!order || !customer || !state) return false;

      const maxDeliveryTime = this._getDeliverySla(customer);
      const elapsed = Math.max(0, simNow - (state.pickedUpAt ?? simNow));
      const remainingSla = maxDeliveryTime - elapsed;
      const etaDirect = haversineMeters(currentPos, customer.pos) / speedMs;

      return etaDirect >= remainingSla;
    });
  }

  async _simulateDriverWithOrder({ driver, order, viableStop, simTime }) {
    const simState = this._buildSimulationState(driver, order.id, simTime);
    let currentPos = { ...driver.pos };
    let simNow = simTime;
    let etaToNewCustomer = Infinity;
    let reachedViable = viableStop?.type === 'driver';
    let pickupInserted = false;
    const routeStops = this._routingPlanner.buildStops(driver, this._world);
    const prefixToViable = reachedViable
      ? []
      : routeStops.filter((_, idx) => idx <= (viableStop?.routeIndex ?? -1));
    let prefixCursor = 0;
    const maxIterations = Object.keys(simState).length * 6 + 10;

    for (let i = 0; i < maxIterations; i++) {
      let activeStops = this._buildActiveStopsFromState(simState);
      if (activeStops.length === 0) break;

      if (!pickupInserted && reachedViable) {
        const restaurant = this._world.restaurants[order.restaurant_id];
        if (restaurant?.pos) {
          activeStops = [{ type: 'pickup', orderId: order.id, pos: restaurant.pos }, ...activeStops.filter((s) => !(s.type === 'pickup' && s.orderId === order.id))];
        }
      }

      const urgent = this._findUrgentDeliveryStops(driver, currentPos, activeStops, simState, simNow);
      let nextStop = null;

      if (!reachedViable && prefixCursor < prefixToViable.length) {
        const expected = prefixToViable[prefixCursor];
        nextStop = activeStops.find((s) => this._isSameStop(s, expected)) ?? null;
      }

      if (!pickupInserted && reachedViable && !nextStop) {
        nextStop = activeStops.find((s) => s.type === 'pickup' && s.orderId === order.id) ?? null;
      }

      if (!nextStop) {
        nextStop = urgent.length > 0
          ? this._closestStop(currentPos, urgent)
          : this._closestStop(currentPos, activeStops);
      }

      if (!nextStop) break;

      const travelTime = await this._estimateTravelTime(currentPos, nextStop.pos, driver);
      simNow += travelTime;
      currentPos = { ...nextStop.pos };

      const state = simState[nextStop.orderId];
      if (!state) continue;

      if (nextStop.type === 'pickup') {
        state.status = 'on_the_way';
        state.pickedUpAt = simNow;
        if (nextStop.orderId === order.id) {
          pickupInserted = true;
        }
      } else {
        state.status = 'delivered';
        if (nextStop.orderId === order.id) {
          etaToNewCustomer = simNow - simTime;
        }
      }

      if (!reachedViable && prefixCursor < prefixToViable.length && this._isSameStop(nextStop, prefixToViable[prefixCursor])) {
        prefixCursor += 1;
      }

      if (!reachedViable && this._isSameStop(nextStop, viableStop)) {
        reachedViable = true;
      }

      if (!reachedViable && prefixCursor >= prefixToViable.length && prefixToViable.length > 0) {
        reachedViable = true;
      }
    }

    const customer = this._world.customers[order.customer_id];
    const newOrderSla = this._getDeliverySla(customer);
    const newOrderWithinSla = Number.isFinite(etaToNewCustomer) && etaToNewCustomer <= newOrderSla;

    const slaBreaches = [];
    for (const orderId of driver.orders ?? []) {
      const o = this._world.orders[orderId];
      const state = simState[orderId];
      if (!o || !state || o.status !== 'on_the_way') continue;

      const existingCustomer = this._world.customers[o.customer_id];
      const maxSla = this._getDeliverySla(existingCustomer);
      if (!Number.isFinite(state.pickedUpAt)) continue;

      const deliveredAt = state.status === 'delivered' ? simNow : Infinity;
      const elapsed = deliveredAt - state.pickedUpAt;

      if (!Number.isFinite(elapsed) || elapsed > maxSla) {
        slaBreaches.push(orderId);
      }
    }

    return {
      valid: Number.isFinite(etaToNewCustomer) && newOrderWithinSla && slaBreaches.length === 0,
      etaToNewCustomer,
      slaBreaches,
    };
  }
}
