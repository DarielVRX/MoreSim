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

    // 🔥 sync world en todos los módulos
    this._routingPlanner.updateWorld(this._world);
    this._kitchen.update({ world: this._world });
    this._finder.update({ world: this._world });
    this._utils.update({ world: this._world });
    this._simulator._world = this._world;

    this._kitchen.tick(dtSim, simTime);

    // 🔥 retry periódico (no duplica por _assigning)
    const pending = Object.values(this._world.orders)
    .filter(o => o.status === 'queued' && o.triggered);

    for (const order of pending) {
      this._tryAssign(order, simTime);
    }
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

    for (const order of queued) {
      this._tryAssign(order, simTime);
    }
  }

  _tryAssign(order, simTime) {
    if (order.status !== 'queued' || !order.triggered || this._assigning.has(order.id)) {
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

    if (!restaurant || !customer) return;

    const distKm = haversineMeters(restaurant.pos, customer.pos) / 1000;

    if (customer.max_distance_km > 0 && distKm > customer.max_distance_km) {
      order.status = 'cancelled';
      return;
    }

    const { viableDrivers, topDrivers } =
    await this._finder.find(order, { restaurant, customer });

    if (viableDrivers.length === 0 || topDrivers.length === 0) return;

    const evaluated =
    await this._simulator.evaluate({ topDrivers, order, simTime });

    const validEvaluated = evaluated.filter(item => item.valid);

    const winnerData =
    (validEvaluated.length > 0 ? validEvaluated : evaluated)
    .sort((a, b) => a.etaToNewCustomer - b.etaToNewCustomer)[0];

    if (!winnerData) return;

    await this._applyAssignment({
      order,
      winnerData,
      evaluated,
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
    startedAtMs,
    simTime,
    restaurant,
    customer
  }) {
    const winner = winnerData.driver;

    if (!Array.isArray(winner.orders)) {
      winner.orders = [];
    }

    order.assignment_score = winnerData.etaToNewCustomer;
    order.status = 'assigned';
    order.driver_id = winner.id;
    order.assigned_at = simTime;
    order._kitchen_elapsed = 0;

    if (!winner.orders.includes(order.id)) {
      winner.orders.push(order.id);
    }

    try {
      const route = await fetchOSRMRoute(restaurant.pos, customer.pos);
      order.route_distance_km = route.distance_m / 1000;
    } catch {
      order.route_distance_km =
      haversineMeters(restaurant.pos, customer.pos) / 1000;
    }

    this._log('assigned', {
      order: order.id,
      driver: winner.name,
      eta: order.assignment_score,
      compute_ms: Date.now() - startedAtMs,
    });

    await this._routingPlanner.replan(winner);
  }

  handleDriverArrived(driver, type, simTime) {
    this._simTime = simTime;
    this._routingPlanner.updateWorld(this._world);

    const { orders, customers } = this._world;

    this._log('driver_arrived', {
      driver: driver.name,
      type,
    });

    // ───────────── PICKUP ─────────────
    if (type === 'at_restaurant') {

      const readyOrders = driver.orders
      .map(id => orders[id])
      .filter(o =>
      o &&
      o.kitchen_status === 'ready' &&
      o.picked_up_at == null
      );

      if (readyOrders.length === 0) return;

      for (const order of readyOrders) {

        order.status = 'on_the_way';
        order.picked_up_at = simTime;

        // 🔥 FIX status driver
        driver.status = 'moving_to_delivery';

        this._log('pickup', {
          driver: driver.name,
          order: order.id,
        });
      }

      this._routingPlanner.replan(driver);
      return;
    }

    // ───────────── DELIVERY ─────────────
    if (type === 'at_customer') {

      const order = driver.orders
      .map(id => orders[id])
      .find(o =>
      o?.status === 'on_the_way' &&
      this._utils.isAtCustomer(driver.pos, customers[o.customer_id].pos)
      );

      if (!order) return;

      order.status = 'delivered';
      order.delivered_at = simTime;

      // 🔥 remover del driver
      driver.orders = driver.orders.filter(id => id !== order.id);

      this._log('delivered', {
        driver: driver.name,
        order: order.id,
      });

      // 🔥 retry pedidos pendientes
      this.handleDriverLoadReduced(driver.id, simTime);

      this._routingPlanner.replan(driver);
    }
  }
}
