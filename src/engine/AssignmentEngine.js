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

  _getParam(name, fallback) {
    const value = this._world?.params?.[name] ?? this._variables?.[name];
    return Number.isFinite(value) ? value : fallback;
  }

  _syncDriverOrdersFromOrderLinks() {
    const byDriver = {};
    for (const driver of Object.values(this._world.drivers)) {
      byDriver[driver.id] = [];
    }

    for (const order of Object.values(this._world.orders)) {
      if (!order?.driver_id) continue;
      if (!['assigned', 'on_the_way'].includes(order.status)) continue;
      if (!byDriver[order.driver_id]) continue;
      byDriver[order.driver_id].push(order.id);
    }

    for (const driver of Object.values(this._world.drivers)) {
      const nextOrders = byDriver[driver.id] ?? [];
      driver.orders = nextOrders;
    }
  }

  updateVariables(vars) {
    this._variables = vars;
    this._utils.update({ variables: vars });
    this._finder.update({ variables: vars });
  }

  tick(dtSim, simTime) {
    this._simTime = simTime;

    this._routingPlanner.updateWorld(this._world);
    this._kitchen.update({ world: this._world });
    this._finder.update({ world: this._world });
    this._utils.update({ world: this._world });
    this._simulator._world = this._world;

    this._syncDriverOrdersFromOrderLinks();
    this._kitchen.tick(dtSim, simTime);
    this._syncWaitingDrivers(simTime, dtSim);
    this._attemptTailTransfers(simTime);

    const pending = this._buildRetryQueue(simTime);

    for (const order of pending) {
      this._tryAssign(order, simTime);
    }
  }

  _buildRetryQueue(simTime) {
    const orders = Object.values(this._world.orders)
    .filter(o => o.status === 'queued' && o.triggered);

    return orders.sort((a, b) => {
      const sa = this._getRetryPriority(a, simTime);
      const sb = this._getRetryPriority(b, simTime);
      return sb - sa;
    });
  }

  _getRetryPriority(order, simTime) {
    const age = Math.max(0, simTime - (order.created_at ?? order.triggered_at ?? 0));
    const customer = this._world.customers[order.customer_id];
    const maxSla = this._utils.getDeliverySla(customer);
    const waitedFromAssign = Number.isFinite(order.assigned_at)
    ? Math.max(0, simTime - order.assigned_at)
    : 0;

    const urgency = Math.max(0, waitedFromAssign - maxSla);
    return age + urgency * 2;
  }

  _syncWaitingDrivers(simTime, dtSim) {
    const { drivers, orders } = this._world;

    for (const driver of Object.values(drivers)) {
      if (driver.status !== 'waiting_at_restaurant') continue;

      const waitingOrders = (driver.orders ?? [])
      .map(orderId => orders[orderId])
      .filter(order =>
      order &&
      order.status === 'assigned' &&
      order.kitchen_status !== 'ready'
      );

      for (const order of waitingOrders) {
        order.pickup_wait_s = (order.pickup_wait_s ?? 0) + dtSim;
      }

      const hasReadyOrder = (driver.orders ?? [])
      .map(orderId => orders[orderId])
      .some(order =>
      order &&
      order.status === 'assigned' &&
      order.kitchen_status === 'ready'
      );

      if (hasReadyOrder) {
        this.handleDriverArrived(driver, 'at_restaurant', simTime);
      }
    }
  }

  async _attemptTailTransfers(simTime) {
    const minGain = this._getParam('transfer_min_gain_s', 120);

    for (const driver of Object.values(this._world.drivers)) {
      const tailOrderId = (driver.orders ?? [])[driver.orders.length - 1];
      if (!tailOrderId) continue;

      const order = this._world.orders[tailOrderId];
      if (!order || order.status !== 'assigned' || order.picked_up_at != null) continue;

      if (order._last_transfer_check && simTime - order._last_transfer_check < 30) continue;
      order._last_transfer_check = simTime;

      const bestAlt = await this._findAlternativeAssignment(order, driver.id, simTime);
      if (!bestAlt || !Number.isFinite(bestAlt.totalCost)) continue;

      const currentCost = await this._estimateCurrentDriverCost(order, driver, simTime);
      if (!Number.isFinite(currentCost)) continue;

      const gain = currentCost - bestAlt.totalCost;
      if (gain < minGain) continue;

      this._log('transfer_order', {
        order: order.id,
        from: driver.id,
        to: bestAlt.driver.id,
        gain_s: gain.toFixed(1),
      });

      order.driver_id = bestAlt.driver.id;
      order.assigned_at = simTime;
      this._syncDriverOrdersFromOrderLinks();
      await this._routingPlanner.replan(driver);
      await this._routingPlanner.replan(bestAlt.driver);
    }
  }

  async _estimateCurrentDriverCost(order, driver, simTime) {
    const evaluation = await this._simulator.evaluate({
      topDrivers: [{ driver, viableStop: { type: 'driver' } }],
      order,
      simTime,
      options: { includeCurrentOrderInState: true },
    });

    return evaluation[0]?.totalCost ?? Infinity;
  }

  async _findAlternativeAssignment(order, excludedDriverId, simTime) {
    const restaurant = this._world.restaurants[order.restaurant_id];
    const customer = this._world.customers[order.customer_id];
    if (!restaurant || !customer) return null;

    const { topDrivers } = await this._finder.find(order, { restaurant, customer });
    const alternatives = topDrivers.filter(c => c.driver.id !== excludedDriverId);
    if (alternatives.length === 0) return null;

    const evaluated = await this._simulator.evaluate({
      topDrivers: alternatives,
      order,
      simTime,
      options: { includeCurrentOrderInState: false },
    });

    return evaluated
    .filter(item => item.validExisting)
    .sort((a, b) => a.totalCost - b.totalCost)[0] ?? null;
  }

  handleOrderCreated(orderId, simTime) {
    this._log('order_created', { orderId });
    const order = this._world.orders[orderId];
    if (order && !Number.isFinite(order.created_at)) order.created_at = simTime;
    if (order) this._tryAssign(order, simTime);
  }

  handleDriverLoadReduced(driverId, simTime) {
    const queued = this._buildRetryQueue(simTime);

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

  _scoreCandidate(candidate, customer) {
    const fairnessWeight = this._getParam('fairness_penalty_per_order_s', 120);
    const softSlaWeight = this._getParam('soft_sla_penalty_factor', 2);
    const activeOrders = candidate.driver?.orders?.length ?? 0;
    const fairnessPenalty = activeOrders * fairnessWeight;

    const maxSla = this._utils.getDeliverySla(customer);
    const delay = Math.max(0, (candidate.etaToNewCustomer ?? Infinity) - maxSla);
    const softSlaPenalty = delay * softSlaWeight;

    return {
      fairnessPenalty,
      softSlaPenalty,
      totalCost: (candidate.etaToNewCustomer ?? Infinity) + fairnessPenalty + softSlaPenalty,
    };
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

    const scored = evaluated.map(candidate => {
      const score = this._scoreCandidate(candidate, customer);
      return { ...candidate, ...score };
    });

    const pool = scored.filter(item => item.validExisting);
    const source = pool.length > 0 ? pool : scored;

    const winnerData = source.sort((a, b) => a.totalCost - b.totalCost)[0];

    if (!winnerData) return;

    await this._applyAssignment({
      order,
      winnerData,
      evaluated: scored,
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

    order.assignment_score = winnerData.totalCost;
    order.status = 'assigned';
    order.driver_id = winner.id;
    order.assigned_at = simTime;
    order._kitchen_elapsed = order._kitchen_elapsed ?? 0;

    this._syncDriverOrdersFromOrderLinks();

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
      eta: winnerData.etaToNewCustomer,
      totalCost: winnerData.totalCost,
      fairnessPenalty: winnerData.fairnessPenalty,
      softSlaPenalty: winnerData.softSlaPenalty,
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

    if (type === 'at_restaurant') {
      const readyOrders = (driver.orders ?? [])
      .map(id => orders[id])
      .filter(o =>
      o &&
      o.driver_id === driver.id &&
      o.kitchen_status === 'ready' &&
      o.picked_up_at == null
      );

      if (readyOrders.length === 0) {
        driver.status = 'waiting_at_restaurant';
        return;
      }

      for (const order of readyOrders) {
        order.status = 'on_the_way';
        order.picked_up_at = simTime;
        driver.status = 'moving_to_delivery';

        this._log('pickup', {
          driver: driver.name,
          order: order.id,
        });
      }

      this._routingPlanner.replan(driver);
      return;
    }

    if (type === 'at_customer') {
      const order = (driver.orders ?? [])
      .map(id => orders[id])
      .find(o =>
      o?.status === 'on_the_way' &&
      o.driver_id === driver.id &&
      this._utils.isAtCustomer(driver.pos, customers[o.customer_id].pos)
      );

      if (!order) return;

      order.status = 'delivered';
      order.delivered_at = simTime;
      order.driver_id = null;

      this._syncDriverOrdersFromOrderLinks();

      this._log('delivered', {
        driver: driver.name,
        order: order.id,
      });

      this.handleDriverLoadReduced(driver.id, simTime);

      this._routingPlanner.replan(driver);
    }
  }
}
