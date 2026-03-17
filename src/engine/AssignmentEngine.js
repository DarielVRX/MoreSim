import { fetchOSRMRoute } from './MovementEngine.js';
import { haversineMeters } from './GraphCache.js';
import { RoutingPlanner } from './RoutingPlanner.js';
import { KitchenEngine } from './KitchenEngine.js';
import { AssignmentUtils } from './AssignmentUtils.js';
import { AssignmentCandidateFinder } from './AssignmentCandidateFinder.js';
import { RouteInsertionSimulator } from './RouteInsertionSimulator.js';

export class AssignmentEngine {
  constructor({ variables, world, movementEngine, onEvent, debug = true }) {
    this._variables = variables;
    this._world = world;
    this._movement = movementEngine;
    this._onEvent = onEvent ?? (() => {});
    this._assigning = new Set();
    this._simTime = 0;
    this._debug = debug;

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
      debug,
    });

    this._simulator = new RouteInsertionSimulator({
      world,
      routingPlanner: this._routingPlanner,
      assignmentUtils: this._utils,
      estimateTravelTime: async (...args) => this._finder._estimateTravelTime(...args),
    });
  }

  // ─────────────────────────────────────────────
  // LOGGER CENTRAL
  // ─────────────────────────────────────────────
  _log(tag, data) {
    if (!this._debug) return;
    console.log(`[Engine:${tag}]`, data);
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
    this._log('order_created', { orderId });
    const order = this._world.orders[orderId];
    if (order) this._tryAssign(order, simTime);
  }

  handleDriverLoadReduced(driverId, simTime) {
    const queued = Object.values(this._world.orders)
    .filter(o => o.status === 'queued' && o.triggered)
    .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));

    if (queued[0]) {
      this._log('retry_assign', {
        driverId,
        nextOrder: queued[0].id,
      });
      this._tryAssign(queued[0], simTime);
    }
  }

  _tryAssign(order, simTime) {
    if (order.status !== 'queued' || !order.triggered || this._assigning.has(order.id)) {
      this._log('skip_assign', {
        order: order.id,
        status: order.status,
        triggered: order.triggered,
        alreadyAssigning: this._assigning.has(order.id),
      });
      return;
    }

    this._assigning.add(order.id);

    this._assignOrder(order, simTime)
    .finally(() => this._assigning.delete(order.id));
  }

  async _assignOrder(order, simTime) {
    const startedAtMs = Date.now();

    const restaurant = this._world.restaurants[order.restaurant_id];
    const customer = this._world.customers[order.customer_id];

    if (!restaurant || !customer) {
      this._log('error', { reason: 'missing_entities', order: order.id });
      return;
    }

    const distKm = haversineMeters(restaurant.pos, customer.pos) / 1000;

    if (customer.max_distance_km > 0 && distKm > customer.max_distance_km) {
      this._log('cancel_distance', {
        order: order.id,
        distance_km: distKm,
      });

      this._onEvent({
        time: simTime,
        type: 'no_driver',
        message: `⛔ Pedido ${order.id} cancelado — distancia ${distKm.toFixed(1)} km supera máximo`,
                    orderId: order.id
      });

      order.status = 'cancelled';
      return;
    }

    const { viableDrivers, topDrivers } =
    await this._finder.find(order, { restaurant, customer });

    if (viableDrivers.length === 0 || topDrivers.length === 0) {
      this._log('no_candidates', {
        order: order.id,
        viable: viableDrivers.length,
      });

      this._onEvent({
        time: simTime,
        type: 'no_driver',
        message: `⚠️ Pedido ${order.id} sin driver disponible`,
        orderId: order.id
      });

      return;
    }

    const evaluated =
    await this._simulator.evaluate({ topDrivers, order, simTime });

    const validEvaluated =
    evaluated.filter(item => item.valid);

    this._log('simulation_result', {
      order: order.id,
      total: evaluated.length,
      valid: validEvaluated.length,
      invalid: evaluated.length - validEvaluated.length,
    });

    // 🔍 Ranking completo
    this._log('ranking', evaluated.map(e => ({
      driver: e.driver.name,
      eta: e.etaToNewCustomer?.toFixed(1),
                                             valid: e.valid,
                                             breaches: e.slaBreaches?.length ?? 0,
    })));

    const winnerData =
    (validEvaluated.length > 0 ? validEvaluated : evaluated)
    .sort((a, b) => a.etaToNewCustomer - b.etaToNewCustomer)[0];

    if (!winnerData) {
      this._log('error', { reason: 'no_winner', order: order.id });
      return;
    }

    this._log('winner_selected', {
      order: order.id,
      driver: winnerData.driver.name,
      eta: winnerData.etaToNewCustomer,
      valid: winnerData.valid,
    });

    await this._applyAssignment({
      order,
      winnerData,
      evaluated,
      viableDrivers,
      topDrivers,
      startedAtMs,
      simTime,
      restaurant,
      customer
    });
  }

  async _applyAssignment({
    order,
    winnerData,
    evaluated,
    viableDrivers,
    topDrivers,
    startedAtMs,
    simTime,
    restaurant,
    customer
  }) {
    const winner = winnerData.driver;

    order.assignment_score = winnerData.etaToNewCustomer;
    order.status = 'assigned';
    order.driver_id = winner.id;
    order.assigned_at = simTime;
    order._kitchen_elapsed = 0;

    order.score_breakdown = evaluated.map(item => ({
      driver: item.driver,
      eta: item.etaToNewCustomer,
      valid: item.valid,
      breaches: item.slaBreaches,
    }));

    try {
      const route = await fetchOSRMRoute(restaurant.pos, customer.pos);
      order.route_distance_km = route.distance_m / 1000;
    } catch {
      order.route_distance_km =
      haversineMeters(restaurant.pos, customer.pos) / 1000;
    }

    if (!winner.orders.includes(order.id)) {
      winner.orders.push(order.id);
    }

    const totalTimeMs = Date.now() - startedAtMs;

    this._log('assigned', {
      order: order.id,
      driver: winner.name,
      eta: order.assignment_score,
      compute_ms: totalTimeMs,
    });

    this._onEvent({
      time: simTime,
      type: 'assigned',
      message: `📦 Pedido ${order.id} → ${winner.name}`,
      orderId: order.id,
      driverId: winner.id,
      results: order.score_breakdown,
    });

    await this._routingPlanner.replan(winner);
  }

  handleDriverArrived(driver, type, simTime) {
    this._simTime = simTime;
    this._routingPlanner.updateWorld(this._world);

    const { orders, restaurants, customers } = this._world;

    this._log('driver_arrived', {
      driver: driver.name,
      type,
    });

    if (type === 'at_restaurant') {

      const ready = driver.orders
      .map(id => orders[id])
      .filter(o => o?.status === 'assigned' && o.kitchen_status === 'ready');

      this._log('restaurant_state', {
        driver: driver.name,
        ready: ready.length,
      });

      return;
    }

    if (type === 'at_customer') {

      const order = driver.orders
      .map(id => orders[id])
      .find(o =>
      o?.status === 'on_the_way' &&
      this._utils.isAtCustomer(driver.pos, customers[o.customer_id].pos)
      );

      if (!order) {
        this._log('warning', {
          driver: driver.name,
          issue: 'no_order_at_customer',
        });
        return;
      }

      this._log('delivered', {
        driver: driver.name,
        order: order.id,
      });

      return;
    }
  }
}
