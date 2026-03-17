export class RebalancingEngine {
  constructor({ world, routingPlanner, simulator, assignmentUtils, etaEstimator, getParam, onLog }) {
    this._world = world;
    this._routingPlanner = routingPlanner;
    this._simulator = simulator;
    this._utils = assignmentUtils;
    this._etaEstimator = etaEstimator;
    this._getParam = getParam;
    this._onLog = onLog ?? (() => {});
  }

  update({ world }) {
    if (world) this._world = world;
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

  async _estimateRouteEta(driver, simTime) {
    const stops = this._routingPlanner.buildStops(driver, this._world);
    if (stops.length === 0) return 0;

    const segmentPromises = stops.map((stop, index) => {
      const fromPos = index === 0 ? driver.pos : stops[index - 1].pos;
      return this._etaEstimator.estimate(fromPos, stop.pos, driver, simTime);
    });
    const segments = await Promise.all(segmentPromises);

    let eta = 0;
    for (let i = 0; i < stops.length; i++) {
      const stop = stops[i];
      eta += segments[i];
      if (stop.type === 'pickup') {
        eta += this._estimateRestaurantWaitForOrder(stop.orderId, simTime + eta, simTime);
      }
    }

    return eta;
  }

  _getTransferableTailOrders(driver, simTime) {
    const cooldown = this._getParam('transfer_cooldown_s', 60);
    const orderIds = driver.orders ?? [];
    const tail = [];

    for (let i = orderIds.length - 1; i >= 0; i--) {
      const order = this._world.orders[orderIds[i]];
      if (!order) continue;

      const underCooldown = Number.isFinite(order.last_transferred_at)
        ? simTime - order.last_transferred_at < cooldown
        : false;

      const transferable =
        order.driver_id === driver.id &&
        order.status === 'assigned' &&
        order.picked_up_at == null &&
        !underCooldown;

      if (!transferable) break;
      tail.push(order.id);
    }

    return tail;
  }

  async _estimateBundleCostForDriver(bundleOrderIds, driver, simTime, includeCurrentOrderInState) {
    let total = 0;
    for (const orderId of bundleOrderIds) {
      const order = this._world.orders[orderId];
      if (!order) return Infinity;

      const [result] = await this._simulator.evaluate({
        topDrivers: [{ driver, viableStop: { type: 'driver' } }],
        order,
        simTime,
        options: { includeCurrentOrderInState },
      });

      if (!result?.validExisting || !Number.isFinite(result.totalCost)) return Infinity;
      total += result.totalCost;
    }

    return total;
  }

  async _findBestRecipientForBundle({ sourceDriver, bundleOrderIds, simTime }) {
    const sourceCost = await this._estimateBundleCostForDriver(bundleOrderIds, sourceDriver, simTime, true);
    if (!Number.isFinite(sourceCost)) return null;

    const recipients = Object.values(this._world.drivers).filter((driver) => driver.id !== sourceDriver.id);

    const evaluations = await Promise.all(
      recipients.map(async (recipient) => {
        const activeOrders = recipient.orders?.length ?? 0;
        const maxOrders = Number.isFinite(recipient.max_orders) ? recipient.max_orders : 1;
        if (activeOrders + bundleOrderIds.length > maxOrders) return null;

        const recipientCost = await this._estimateBundleCostForDriver(bundleOrderIds, recipient, simTime, false);
        if (!Number.isFinite(recipientCost)) return null;

        return { driver: recipient, gain: sourceCost - recipientCost };
      })
    );

    const best = evaluations.filter(Boolean).sort((a, b) => b.gain - a.gain)[0];
    if (!best) return null;

    const routeEta = await this._estimateRouteEta(best.driver, simTime);
    return { ...best, routeEta };
  }

  async run(simTime) {
    const minGain = this._getParam('transfer_min_gain_s', 10);
    const maxRouteEta = this._getParam('transfer_max_route_eta_s', 180);

    const drivers = Object.values(this._world.drivers);
    const routeCandidates = await Promise.all(
      drivers.map(async (driver) => ({
        driver,
        routeEta: await this._estimateRouteEta(driver, simTime),
        transferableTail: this._getTransferableTailOrders(driver, simTime),
      }))
    );

    const overloadedRoutes = routeCandidates.filter((route) =>
      Number.isFinite(route.routeEta) && route.routeEta > maxRouteEta && route.transferableTail.length > 0
    );

    const proposals = await Promise.all(
      overloadedRoutes.map(async ({ driver, transferableTail, routeEta }) => {
        const bundleOrderIds = [transferableTail[0]];
        const bestRecipient = await this._findBestRecipientForBundle({ sourceDriver: driver, bundleOrderIds, simTime });
        if (!bestRecipient || bestRecipient.gain < minGain) return null;
        return {
          sourceDriverId: driver.id,
          targetDriverId: bestRecipient.driver.id,
          bundleOrderIds,
          sourceRouteEta: routeEta,
          targetRouteEta: bestRecipient.routeEta,
          gain: bestRecipient.gain,
        };
      })
    );

    const validProposals = proposals.filter(Boolean).sort((a, b) => b.gain - a.gain);
    const replans = new Set();

    for (const proposal of validProposals) {
      const sourceDriver = this._world.drivers[proposal.sourceDriverId];
      const targetDriver = this._world.drivers[proposal.targetDriverId];
      if (!sourceDriver || !targetDriver) continue;

      for (const orderId of proposal.bundleOrderIds) {
        const order = this._world.orders[orderId];
        if (!order) continue;
        order.driver_id = targetDriver.id;
        order.assigned_at = simTime;
        order.last_transferred_at = simTime;
      }

      this._onLog('transfer_bundle', proposal);
      replans.add(sourceDriver.id);
      replans.add(targetDriver.id);
    }

    await Promise.all(Array.from(replans).map((driverId) => this._routingPlanner.replan(this._world.drivers[driverId])));
    return validProposals.length;
  }
}
