// src/engine/AssignmentEngine.js

import { fetchOSRMRoute } from './MovementEngine.js';
import { haversineMeters } from './GraphCache.js';
import { RoutingPlanner } from './RoutingPlanner.js';
import { KitchenEngine } from './KitchenEngine.js';
import { AssignmentUtils } from './AssignmentUtils.js';
import { AssignmentCandidateFinder } from './AssignmentCandidateFinder.js';
import { RouteInsertionSimulator } from './RouteInsertionSimulator.js';

export class AssignmentEngine {
  constructor({ variables, world, movementEngine, onEvent }) {
    this._variables = variables;
    this._world = world;
    this._movement = movementEngine;
    this._onEvent = onEvent ?? (() => {});
    this._assigning = new Set();
    this._simTime = 0;

    this._routingPlanner = new RoutingPlanner({
      world: this._world,
      movementEngine: this._movement,
      onEvent: this._onEvent,
      getSimTime: () => this._simTime,
    });

    this._utils = new AssignmentUtils({ world, variables, onEvent: this._onEvent });
    this._kitchen = new KitchenEngine({ world, onEvent: this._onEvent });
    this._finder = new AssignmentCandidateFinder({
      world,
      variables,
      routingPlanner: this._routingPlanner,
      assignmentUtils: this._utils,
    });
    this._simulator = new RouteInsertionSimulator({
      world,
      routingPlanner: this._routingPlanner,
      assignmentUtils: this._utils,
      estimateTravelTime: async (...args) => this._finder._estimateTravelTime(...args),
    });
  }

  updateVariables(vars) {
    this._variables = vars;
    this._utils.update({ variables: vars });
    this._finder.update({ variables: vars });
  }

  tick(dtSim, simTime) {
    this._simTime = simTime;
    this._routingPlanner.updateWorld(this._world);
    this._kitchen.tick(dtSim, simTime);
  }

  handleOrderCreated(orderId, simTime) {
    const order = this._world.orders[orderId];
    if (order) this._tryAssign(order, simTime);
  }

  handleDriverLoadReduced(driverId, simTime) {
    const queued = Object.values(this._world.orders)
      .filter((o) => o.status === 'queued' && o.triggered)
      .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
    if (queued[0]) this._tryAssign(queued[0], simTime);
  }

  _tryAssign(order, simTime) {
    if (order.status !== 'queued' || !order.triggered || this._assigning.has(order.id)) return;
    this._assigning.add(order.id);
    this._assignOrder(order, simTime).finally(() => this._assigning.delete(order.id));
  }

  async _assignOrder(order, simTime) {
    const startedAtMs = Date.now();
    const restaurant = this._world.restaurants[order.restaurant_id];
    const customer = this._world.customers[order.customer_id];
    if (!restaurant || !customer) return;

    const distKm = haversineMeters(restaurant.pos, customer.pos) / 1000;
    if (customer.max_distance_km > 0 && distKm > customer.max_distance_km) {
      this._onEvent({ time: simTime, type: 'no_driver', message: `⛔ Pedido ${order.id} cancelado — distancia ${distKm.toFixed(1)} km supera máximo`, orderId: order.id });
      order.status = 'cancelled';
      return;
    }

    const { viableDrivers, topDrivers } = await this._finder.find(order, { restaurant, customer });
    if (viableDrivers.length === 0 || topDrivers.length === 0) {
      this._onEvent({ time: simTime, type: 'no_driver', message: `⚠️ Pedido ${order.id} sin driver disponible`, orderId: order.id });
      return;
    }

    const evaluated = await this._simulator.evaluate({ topDrivers, order, simTime });
    const validEvaluated = evaluated.filter((item) => item.valid);
    const winnerData = (validEvaluated.length > 0 ? validEvaluated : evaluated)
      .sort((a, b) => a.etaToNewCustomer - b.etaToNewCustomer)[0];
    if (!winnerData) return;

    await this._applyAssignment({ order, winnerData, evaluated, viableDrivers, topDrivers, startedAtMs, simTime, restaurant, customer });
  }

  async _applyAssignment({ order, winnerData, evaluated, viableDrivers, topDrivers, startedAtMs, simTime, restaurant, customer }) {
    const winner = winnerData.driver;
    order.assignment_score = winnerData.etaToNewCustomer;
    order.status = 'assigned';
    order.driver_id = winner.id;
    order.assigned_at = simTime;
    order._kitchen_elapsed = 0;
    order.score_breakdown = evaluated.map((item) => ({
      driver: item.driver,
      eta_total_prelim_s: item.etaTotalPrelim,
      eta_candidate_s: item.etaCandidate,
      eta_new_customer_s: item.etaToNewCustomer,
      sla_route_valid: item.valid,
      sla_breaches: item.slaBreaches,
    }));

    try { order.route_distance_km = (await fetchOSRMRoute(restaurant.pos, customer.pos)).distance_m / 1000; }
    catch { order.route_distance_km = haversineMeters(restaurant.pos, customer.pos) / 1000; }

    if (!winner.orders.includes(order.id)) winner.orders.push(order.id);
    winner.orders.sort((a, b) => (this._world.orders[b]?.assignment_score ?? 0) - (this._world.orders[a]?.assignment_score ?? 0));

    this._onEvent({ time: simTime, type: 'assigned', message: `📦 Pedido ${order.id} → ${winner.name}`, orderId: order.id, driverId: winner.id, results: order.score_breakdown });
    this._onEvent({
      time: simTime,
      type: 'assignment_audit',
      message: `🧪 assign ${order.id}: viables=${viableDrivers.length}, top10=${topDrivers.length}, ganador=${winner.name}, eta_nuevo=${order.assignment_score.toFixed(1)}s`,
      orderId: order.id,
      driverId: winner.id,
      elapsed_ms: Date.now() - startedAtMs,
      winner_eta_to_restaurant_s: winnerData.etaToRestaurant ?? null,
    });

    await this._routingPlanner.replan(winner);
  }

  handleDriverArrived(driver, type, simTime) {
    this._simTime = simTime;
    this._routingPlanner.updateWorld(this._world);
    const { orders, restaurants, customers } = this._world;

    if (type === 'at_restaurant') {
      driver.status = 'waiting_at_restaurant';
      const rest = restaurants[driver.current_restaurant_id];
      this._utils.emitRouteAudit(driver, simTime, 'restaurant');

      const assigned = driver.orders.map((id) => orders[id]).filter((o) => o?.status === 'assigned' && o.restaurant_id === driver.current_restaurant_id);
      const ready = assigned.filter((o) => o.kitchen_status === 'ready');
      const preparing = assigned.filter((o) => o.kitchen_status !== 'ready');

      if (ready.length > 0) this._onEvent({ time: simTime, type: 'arrived_restaurant', message: `🏪 ${driver.name} llegó a ${rest?.name ?? 'comercio'} — ${ready.length} pedido(s) listos para retirar`, driverId: driver.id });
      else {
        const nextPrep = preparing.map((o) => (rest?.prep_time_s ?? 600) - (o._kitchen_elapsed ?? 0)).filter(Number.isFinite).reduce((m, v) => Math.min(m, v), Infinity);
        this._onEvent({ time: simTime, type: 'arrived_restaurant', message: `🏪 ${driver.name} llegó a ${rest?.name ?? 'comercio'} — sin pedidos listos (${preparing.length} preparando, ETA ${Number.isFinite(nextPrep) ? Math.max(0, nextPrep).toFixed(0) : '?'}s)`, driverId: driver.id });
      }

      for (const order of ready) {
        order.status = 'on_the_way';
        order.picked_up_at = simTime;
        this._onEvent({ time: simTime, type: 'pickup', message: `📦 ${driver.name} retiró pedido ${order.id}`, orderId: order.id, driverId: driver.id });
      }
      if (ready.length > 0) this._routingPlanner.planNextStop(driver, this._world, 'driver_arrived_restaurant');
      return;
    }

    if (type === 'at_customer') {
      const order = driver.orders.map((id) => orders[id]).find((o) => o?.status === 'on_the_way' && this._utils.isAtCustomer(driver.pos, customers[o.customer_id].pos));
      if (!order) return;
      order.status = 'delivered';
      order.delivered_at = simTime;
      driver._arrival_type = null;
      driver.orders = driver.orders.filter((id) => id !== order.id);
      this._utils.emitRouteAudit(driver, simTime, 'customer', order);
      this._onEvent({ time: simTime, type: 'delivered', message: `✅ ${driver.name} entregó pedido ${order.id}`, orderId: order.id, driverId: driver.id });
      this.handleDriverLoadReduced(driver.id, simTime);
      this._routingPlanner.planNextStop(driver, this._world, 'driver_arrived_customer');
      return;
    }

    if (type === 'at_free_dest') {
      driver.status = 'waiting_at_restaurant';
      driver.idle_elapsed = 0;
    }
  }
}
