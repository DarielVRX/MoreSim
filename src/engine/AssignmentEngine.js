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
    const minGain = this._getParam('transfer_min_gain_s', 10);
    const maxRouteEta = this._getParam('transfer_max_route_eta_s', 180);

    const drivers = Object.values(this._world.drivers);

    const routeCandidates = await Promise.all(
      drivers.map(async (driver) => ({
        driver,
        routeEta: await this._estimateRouteEta(driver, simTime),
        transferableTail: this._getTransferableTailOrders(driver),
      }))
    );

    const overloadedRoutes = routeCandidates.filter((route) =>
      Number.isFinite(route.routeEta) &&
      route.routeEta > maxRouteEta &&
      route.transferableTail.length > 0
    );

    if (overloadedRoutes.length === 0) return;

    const proposals = await Promise.all(
      overloadedRoutes.map((route) =>
        this._buildGrowingPackageProposal({
          sourceDriver: route.driver,
          transferableTail: route.transferableTail,
          sourceRouteEta: route.routeEta,
          simTime,
          minGain,
        })
      )
    );

    const validProposals = proposals
    .filter(Boolean)
    .sort((a, b) => b.gain - a.gain);

    const scheduledReplans = new Set();

    for (const proposal of validProposals) {
      const sourceDriver = this._world.drivers[proposal.sourceDriverId];
      const targetDriver = this._world.drivers[proposal.targetDriverId];
      if (!sourceDriver || !targetDriver) continue;

      const sourceOrders = proposal.bundleOrderIds.map(id => this._world.orders[id]).filter(Boolean);

      const stillTransferable = sourceOrders.every(order =>
        order.driver_id === sourceDriver.id &&
        order.status === 'assigned' &&
        order.picked_up_at == null
      );

      if (!stillTransferable) continue;

      const targetActive = targetDriver.orders?.length ?? 0;
      const targetMax = Number.isFinite(targetDriver.max_orders) ? targetDriver.max_orders : 1;
      if (targetActive + proposal.bundleOrderIds.length > targetMax) continue;

      for (const order of sourceOrders) {
        order.driver_id = targetDriver.id;
        order.assigned_at = simTime;
      }

      this._log('transfer_bundle', {
        from: sourceDriver.id,
        to: targetDriver.id,
        bundle: proposal.bundleOrderIds,
        packageSize: proposal.bundleOrderIds.length,
        sourceRouteEta: proposal.sourceRouteEta.toFixed(1),
        targetRouteEta: proposal.targetRouteEta.toFixed(1),
        gain_s: proposal.gain.toFixed(1),
      });

      scheduledReplans.add(sourceDriver.id);
      scheduledReplans.add(targetDriver.id);
      this._syncDriverOrdersFromOrderLinks();
    }

    await Promise.all(
      Array.from(scheduledReplans).map((driverId) =>
        this._routingPlanner.replan(this._world.drivers[driverId])
      )
    );
  }

  async _estimateRouteEta(driver, simTime) {
    const stops = this._routingPlanner.buildStops(driver, this._world);
    if (stops.length === 0) return 0;

    let eta = 0;
    let currentPos = driver.pos;

    for (const stop of stops) {
      const travel = await this._finder._estimateTravelTime(currentPos, stop.pos, driver);
      eta += travel;

      if (stop.type === 'pickup') {
        const wait = this._estimateRestaurantWaitForOrder(stop.orderId, simTime + eta, simTime);
        eta += wait;
      }

      currentPos = stop.pos;
    }

    return eta;
  }

  _estimateRestaurantWaitForOrder(orderId, arrivalTime, simTime) {
    const order = this._world.orders[orderId];
    if (!order || order.kitchen_status === 'ready') return 0;

    const restaurant = this._world.restaurants[order.restaurant_id];
    const prepTime = restaurant?.prep_time_s ?? 600;
    const cooked = order._kitchen_elapsed ?? 0;
    const remainingNow = Math.max(0, prepTime - cooked);
    const elapsedUntilArrival = Math.max(0, arrivalTime - simTime);
    return Math.max(0, remainingNow - elapsedUntilArrival);
  }

  _getTransferableTailOrders(driver) {
    const orderIds = driver.orders ?? [];
    const tail = [];

    for (let i = orderIds.length - 1; i >= 0; i--) {
      const order = this._world.orders[orderIds[i]];
      if (!order) continue;

      const transferable =
      order.driver_id === driver.id &&
      order.status === 'assigned' &&
      order.picked_up_at == null;

      if (!transferable) break;

      tail.push(order.id);
    }

    return tail;
  }

  async _buildGrowingPackageProposal({ sourceDriver, transferableTail, sourceRouteEta, simTime, minGain }) {
    for (let size = 1; size <= transferableTail.length; size++) {
      const bundleOrderIds = transferableTail.slice(0, size);

      const bestRecipient = await this._findBestRecipientForBundle({
        sourceDriver,
        bundleOrderIds,
        simTime,
      });

      if (!bestRecipient) continue;
      if (bestRecipient.gain < minGain) continue;

      return {
        sourceDriverId: sourceDriver.id,
        targetDriverId: bestRecipient.driver.id,
        bundleOrderIds,
        sourceRouteEta,
        targetRouteEta: bestRecipient.routeEta,
        gain: bestRecipient.gain,
      };
    }

    return null;
  }

  async _findBestRecipientForBundle({ sourceDriver, bundleOrderIds, simTime }) {
    const sourceCost = await this._estimateBundleCostForDriver(bundleOrderIds, sourceDriver, simTime, true);
    if (!Number.isFinite(sourceCost)) return null;

    const recipients = Object.values(this._world.drivers)
    .filter(driver => driver.id !== sourceDriver.id);

    let best = null;

    for (const recipient of recipients) {
      const activeOrders = recipient.orders?.length ?? 0;
      const maxOrders = Number.isFinite(recipient.max_orders) ? recipient.max_orders : 1;
      if (activeOrders + bundleOrderIds.length > maxOrders) continue;

      const recipientCost = await this._estimateBundleCostForDriver(bundleOrderIds, recipient, simTime, false);
      if (!Number.isFinite(recipientCost)) continue;

      const gain = sourceCost - recipientCost;
      if (!best || gain > best.gain) {
        best = { driver: recipient, gain };
      }
    }

    if (!best) return null;

    const routeEta = await this._estimateRouteEta(best.driver, simTime);
    return {
      ...best,
      routeEta,
    };
  }

  async _estimateBundleCostForDriver(bundleOrderIds, driver, simTime, includeCurrentOrderInState) {
    let total = 0;

    for (const orderId of bundleOrderIds) {
      const order = this._world.orders[orderId];
      if (!order) return Infinity;

      const evaluation = await this._simulator.evaluate({
        topDrivers: [{ driver, viableStop: { type: 'driver' } }],
        order,
        simTime,
        options: { includeCurrentOrderInState },
      });

      const result = evaluation[0];
      if (!result?.validExisting || !Number.isFinite(result.totalCost)) return Infinity;

      total += result.totalCost;
    }

    return total;
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
