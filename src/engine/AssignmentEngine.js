import { fetchOSRMRoute } from './MovementEngine.js';
import { haversineMeters } from './GraphCache.js';
import { RoutingPlanner } from './RoutingPlanner.js';
import { KitchenEngine } from './KitchenEngine.js';
import { AssignmentUtils } from './AssignmentUtils.js';
import { AssignmentCandidateFinder } from './AssignmentCandidateFinder.js';
import { RouteInsertionSimulator } from './RouteInsertionSimulator.js';
import { EtaEstimator } from './EtaEstimator.js';
import { RebalancingEngine } from './RebalancingEngine.js';

export class AssignmentEngine {
  constructor({ variables, world, movementEngine, onEvent, debug = true }) {
    this._variables = variables;
    this._world = world;
    this._movement = movementEngine;
    this._onEvent = onEvent ?? (() => {});
    this._assigning = new Set();
    this._simTime = 0;
    this._debug = debug;
    this._rebalancingInFlight = false;
    this._tickSimulationCount = 0;

    this._routingPlanner = new RoutingPlanner({
      world: this._world,
      movementEngine: this._movement,
      onEvent: this._onEvent,
      getSimTime: () => this._simTime,
    });

    this._utils = new AssignmentUtils({ world, variables, onEvent: this._onEvent });
    this._kitchen = new KitchenEngine({ world, onEvent: this._onEvent });
    this._etaEstimator = new EtaEstimator({ assignmentUtils: this._utils });

    this._finder = new AssignmentCandidateFinder({
      world,
      variables,
      routingPlanner: this._routingPlanner,
      assignmentUtils: this._utils,
      etaEstimator: this._etaEstimator,
      debug,
    });

    this._simulator = new RouteInsertionSimulator({
      world,
      routingPlanner: this._routingPlanner,
      assignmentUtils: this._utils,
      estimateTravelTime: (fromPos, toPos, driver) => this._etaEstimator.estimate(fromPos, toPos, driver, this._simTime),
    });

    this._rebalancer = new RebalancingEngine({
      world,
      routingPlanner: this._routingPlanner,
      simulator: this._simulator,
      assignmentUtils: this._utils,
      etaEstimator: this._etaEstimator,
      getParam: (name, fallback) => this._getParam(name, fallback),
      onLog: (tag, data) => this._log(tag, data),
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
    for (const driver of Object.values(this._world.drivers)) byDriver[driver.id] = [];
    for (const order of Object.values(this._world.orders)) {
      if (!order?.driver_id) continue;
      if (!['assigned', 'on_the_way'].includes(order.status)) continue;
      if (!byDriver[order.driver_id]) continue;
      byDriver[order.driver_id].push(order.id);
    }
    for (const driver of Object.values(this._world.drivers)) driver.orders = byDriver[driver.id] ?? [];
  }

  updateVariables(vars) {
    this._variables = vars;
    this._utils.update({ variables: vars });
    this._etaEstimator.update({ assignmentUtils: this._utils });
    this._finder.update({ variables: vars });
  }

  tick(dtSim, simTime) {
    this._simTime = simTime;
    this._tickSimulationCount = 0;

    this._routingPlanner.updateWorld(this._world);
    this._kitchen.update({ world: this._world });
    this._finder.update({ world: this._world, etaEstimator: this._etaEstimator });
    this._utils.update({ world: this._world });
    this._simulator._world = this._world;
    this._rebalancer.update({ world: this._world });

    this._syncDriverOrdersFromOrderLinks();
    this._kitchen.tick(dtSim, simTime);
    this._syncWaitingDrivers(simTime, dtSim);

    if (!this._rebalancingInFlight) {
      this._rebalancingInFlight = true;
      this._rebalancer.run(simTime)
        .finally(() => {
          this._syncDriverOrdersFromOrderLinks();
          this._rebalancingInFlight = false;
        });
    }

    const pending = this._buildRetryQueue(simTime);
    this._processRetryBatches(pending, simTime);
  }

  _buildRetryQueue(simTime) {
    const orders = Object.values(this._world.orders)
      .filter((o) => o.status === 'queued' && o.triggered)
      .filter((o) => !Number.isFinite(o.next_retry_at) || o.next_retry_at <= simTime);

    return orders.sort((a, b) => this._getRetryPriority(b, simTime) - this._getRetryPriority(a, simTime));
  }

  _getRetryPriority(order, simTime) {
    const age = Math.max(0, simTime - (order.created_at ?? order.triggered_at ?? 0));
    const customer = this._world.customers[order.customer_id];
    const maxSla = this._utils.getDeliverySla(customer);
    const waitedFromAssign = Number.isFinite(order.assigned_at) ? Math.max(0, simTime - order.assigned_at) : 0;
    const urgency = Math.max(0, waitedFromAssign - maxSla);
    return age + urgency * 2;
  }

  _processRetryBatches(pending, simTime) {
    const batchSize = Math.max(1, this._getParam('assignment_batch_size', 4));
    for (let i = 0; i < pending.length; i += batchSize) {
      const batch = pending.slice(i, i + batchSize);
      Promise.all(batch.map((order) => this._tryAssign(order, simTime)));
    }
  }

  _syncWaitingDrivers(simTime, dtSim) {
    const { drivers, orders } = this._world;
    for (const driver of Object.values(drivers)) {
      if (driver.status !== 'waiting_at_restaurant') continue;
      const waitingOrders = (driver.orders ?? []).map((orderId) => orders[orderId]).filter((order) => order && order.status === 'assigned' && order.kitchen_status !== 'ready');
      for (const order of waitingOrders) order.pickup_wait_s = (order.pickup_wait_s ?? 0) + dtSim;
      const hasReadyOrder = (driver.orders ?? []).map((orderId) => orders[orderId]).some((order) => order && order.status === 'assigned' && order.kitchen_status === 'ready');
      if (hasReadyOrder) this.handleDriverArrived(driver, 'at_restaurant', simTime);
    }
  }

  handleOrderCreated(orderId, simTime) {
    this._log('order_created', { orderId });
    const order = this._world.orders[orderId];
    if (order && !Number.isFinite(order.created_at)) order.created_at = simTime;
    if (order) this._tryAssign(order, simTime);
  }

  handleDriverLoadReduced(driverId, simTime) {
    const queued = this._buildRetryQueue(simTime);
    this._processRetryBatches(queued, simTime);
  }

  _scheduleRetry(order, simTime) {
    order.retry_count = (order.retry_count ?? 0) + 1;
    const baseDelay = this._getParam('assignment_retry_base_s', 2);
    const maxDelay = this._getParam('assignment_retry_max_s', 60);
    const nextDelay = Math.min(maxDelay, baseDelay * (2 ** Math.max(0, order.retry_count - 1)));
    order.next_retry_at = simTime + nextDelay;
  }

  _tryAssign(order, simTime) {
    if (order.status !== 'queued' || !order.triggered || this._assigning.has(order.id)) return Promise.resolve();
    this._assigning.add(order.id);

    return this._assignOrder(order, simTime)
      .then((assigned) => {
        if (assigned) {
          order.retry_count = 0;
          order.next_retry_at = simTime;
          return;
        }
        this._scheduleRetry(order, simTime);
      })
      .catch(() => this._scheduleRetry(order, simTime))
      .finally(() => this._assigning.delete(order.id));
  }

  _scoreCandidate(candidate, customer) {
    const fairnessWeight = this._getParam('fairness_penalty_per_order_s', 120);
    const softSlaWeight = this._getParam('soft_sla_penalty_factor', 2);
    const hardPenalty = this._getParam('hard_sla_penalty_s', 3000);
    const activeOrders = candidate.driver?.orders?.length ?? 0;
    const fairnessPenalty = activeOrders * fairnessWeight;

    const maxSla = this._utils.getDeliverySla(customer);
    const delay = Math.max(0, (candidate.etaToNewCustomer ?? Infinity) - maxSla);
    const softSlaPenalty = delay * softSlaWeight;
    const hardSlaPenalty = delay > 0 ? hardPenalty : 0;

    return {
      fairnessPenalty,
      softSlaPenalty,
      hardSlaPenalty,
      totalCost: (candidate.etaToNewCustomer ?? Infinity) + fairnessPenalty + softSlaPenalty + hardSlaPenalty,
    };
  }
  // ── NUEVO: helper para reservas ─────────────────────────────────────────────
  _getDriverReservedSlots(driver) {
    return driver._reservedSlots ?? 0;
  }

  _reserveDriverSlot(driver) {
    driver._reservedSlots = (driver._reservedSlots ?? 0) + 1;
  }

  _releaseDriverSlot(driver) {
    driver._reservedSlots = Math.max(0, (driver._reservedSlots ?? 1) - 1);
  }

  async _assignOrder(order, simTime) {
    const startedAtMs = Date.now();
    const restaurant = this._world.restaurants[order.restaurant_id];
    const customer = this._world.customers[order.customer_id];
    if (!restaurant || !customer) return false;

    const distKm = haversineMeters(restaurant.pos, customer.pos) / 1000;
    if (customer.max_distance_km > 0 && distKm > customer.max_distance_km) {
      order.status = 'cancelled';
      return true;
    }

    const { viableDrivers, topDrivers } = await this._finder.find(order, { restaurant, customer, simTime });

    // filtrar por capacidad REAL (con reservas)
    const capacityFiltered = topDrivers.filter(({ driver }) => {
      const activeOrders = driver.orders?.length ?? 0;
      const reserved = this._getDriverReservedSlots(driver);
      const maxOrders = Number.isFinite(driver.max_orders) ? driver.max_orders : 1;

      return (activeOrders + reserved) < maxOrders;
    });

    if (capacityFiltered.length === 0) return false;

    const simulationBudget = this._getParam('simulation_budget_per_tick', 75);
    const remainingBudget = Math.max(0, simulationBudget - this._tickSimulationCount);
    if (remainingBudget <= 0) return false;

    const cappedTopDrivers = capacityFiltered.slice(0, remainingBudget);
    this._tickSimulationCount += cappedTopDrivers.length;

    // reservar slots
    for (const candidate of cappedTopDrivers) {
      this._reserveDriverSlot(candidate.driver);
    }

    const evaluated = await this._simulator.evaluate({
      topDrivers: cappedTopDrivers,
      order,
      simTime
    });

    const scored = evaluated.map((candidate) => ({
      ...candidate,
      ...this._scoreCandidate(candidate, customer)
    }));

    const pool = scored.filter((item) => item.validExisting);
    const source = pool.length > 0 ? pool : scored;
    const winnerData = source.sort((a, b) => a.totalCost - b.totalCost)[0];

    if (!winnerData) {
      // liberar todos
      for (const candidate of cappedTopDrivers) {
        this._releaseDriverSlot(candidate.driver);
      }
      return false;
    }

    // liberar todos EXCEPTO ganador
    for (const candidate of cappedTopDrivers) {
      if (candidate.driver.id !== winnerData.driver.id) {
        this._releaseDriverSlot(candidate.driver);
      }
    }

    await this._applyAssignment({
      order,
      winnerData,
      startedAtMs,
      simTime,
      restaurant,
      customer
    });

    return true;
    }

    async _applyAssignment({ order, winnerData, startedAtMs, simTime, restaurant, customer }) {
      const winner = winnerData.driver;

      // liberar reserva del ganador (se convierte en asignación real)
      this._releaseDriverSlot(winner);

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
      order.route_distance_km = haversineMeters(restaurant.pos, customer.pos) / 1000;
    }

    this._log('assigned', {
      order: order.id,
      driver: winner.name,
      eta: winnerData.etaToNewCustomer,
      totalCost: winnerData.totalCost,
      fairnessPenalty: winnerData.fairnessPenalty,
      softSlaPenalty: winnerData.softSlaPenalty,
      hardSlaPenalty: winnerData.hardSlaPenalty,
      compute_ms: Date.now() - startedAtMs,
    });

    await this._routingPlanner.replan(winner);
  }

  handleDriverArrived(driver, type, simTime) {
    this._simTime = simTime;
    this._routingPlanner.updateWorld(this._world);

    const { orders, customers } = this._world;

    if (type === 'at_restaurant') {
      const readyOrders = (driver.orders ?? [])
      .map(id => orders[id])
      .filter(o =>
      o &&
      o.driver_id === driver.id &&
      o.kitchen_status === 'ready' &&
      o.picked_up_at == null &&
      o.restaurant_id === driver.current_restaurant_id
      );
      if (readyOrders.length === 0) {
        driver.status = 'waiting_at_restaurant';
        return;
      }

      for (const order of readyOrders) {
        order.status = 'on_the_way';
        order.picked_up_at = simTime;
        driver.status = 'moving_to_delivery';
      }

      this._routingPlanner.replan(driver);
      return;
    }

    if (type === 'at_customer') {
      const order = (driver.orders ?? []).map((id) => orders[id]).find((o) => o?.status === 'on_the_way' && o.driver_id === driver.id && this._utils.isAtCustomer(driver.pos, customers[o.customer_id].pos));
      if (!order) return;

      order.status = 'delivered';
      order.delivered_at = simTime;
      order.driver_id = null;

      this._syncDriverOrdersFromOrderLinks();
      this.handleDriverLoadReduced(driver.id, simTime);
      this._routingPlanner.replan(driver);
    }
  }
}
