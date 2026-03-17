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

  _estimateRestaurantWaitForOrder(orderId, elapsedUntilArrival = 0) {
    const order = this._world.orders[orderId];
    if (!order || order.kitchen_status === 'ready') return 0;

    const restaurant = this._world.restaurants[order.restaurant_id];
    const prepTime = restaurant?.prep_time_s ?? 600;
    const cooked = order._kitchen_elapsed ?? 0;

    const remainingAtNow = Math.max(0, prepTime - cooked);
    return Math.max(0, remainingAtNow - Math.max(0, elapsedUntilArrival));
  }

  async _estimateRouteEta(driver) {
    const stops = this._routingPlanner.buildStops(driver, this._world);
    if (stops.length === 0) return 0;

    const segmentPromises = stops.map((stop, index) => {
      const fromPos = index === 0 ? driver.pos : stops[index - 1].pos;
      return this._etaEstimator.estimate(fromPos, stop.pos, driver);
    });

    const segments = await Promise.all(segmentPromises);

    let eta = 0;

    for (let i = 0; i < stops.length; i++) {
      const stop = stops[i];
      eta += segments[i];

      if (stop.type === 'pickup') {
        eta += this._estimateRestaurantWaitForOrder(stop.orderId, eta);
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

      if (!transferable) continue;

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

  async _withTemporaryTransfer(bundleOrderIds, sourceDriver, targetDriver, task) {
    const previousOwners = new Map();

    for (const orderId of bundleOrderIds) {
      const order = this._world.orders[orderId];
      if (!order) continue;
      previousOwners.set(orderId, order.driver_id);
      order.driver_id = targetDriver.id;
    }

    this._syncDriverOrders(sourceDriver);
    this._syncDriverOrders(targetDriver);

    try {
      return await task();
    } finally {
      for (const [orderId, driverId] of previousOwners.entries()) {
        const order = this._world.orders[orderId];
        if (!order) continue;
        order.driver_id = driverId;
      }
      this._syncDriverOrders(sourceDriver);
      this._syncDriverOrders(targetDriver);
    }
  }

  async _findBestRecipientForBundle({ sourceDriver, bundleOrderIds, simTime }) {
    const sourceBaseRouteEta = await this._estimateRouteEta(sourceDriver);
    if (!Number.isFinite(sourceBaseRouteEta)) return null;

    const recipients = Object.values(this._world.drivers)
    .filter((driver) => driver.id !== sourceDriver.id);

    const evaluations = await Promise.all(
      recipients.map(async (recipient) => {
        const activeOrders = recipient.orders?.length ?? 0;
        const maxOrders = Number.isFinite(recipient.max_orders) ? recipient.max_orders : 1;
        if (activeOrders + bundleOrderIds.length > maxOrders) return null;

        const recipientBundleCost = await this._estimateBundleCostForDriver(
          bundleOrderIds,
          recipient,
          simTime,
          false
        );
        if (!Number.isFinite(recipientBundleCost)) return null;

        const transferEffect = await this._withTemporaryTransfer(
          bundleOrderIds,
          sourceDriver,
          recipient,
          async () => {
            const [sourceRouteEtaAfterTransfer, recipientRouteEtaAfterTransfer] = await Promise.all([
              this._estimateRouteEta(sourceDriver),
              this._estimateRouteEta(recipient),
            ]);
            return { sourceRouteEtaAfterTransfer, recipientRouteEtaAfterTransfer };
          }
        );

        const { sourceRouteEtaAfterTransfer, recipientRouteEtaAfterTransfer } = transferEffect;
        if (!Number.isFinite(sourceRouteEtaAfterTransfer) || !Number.isFinite(recipientRouteEtaAfterTransfer)) return null;

        // Regla pedida: el receptor no debe quedar con una ruta peor al ETA base del origen pre-transfer.
        if (recipientRouteEtaAfterTransfer > sourceBaseRouteEta) return null;

        const gain = sourceBaseRouteEta - sourceRouteEtaAfterTransfer;
        if (gain <= 0) return null;

        return {
          driver: recipient,
          gain,
          recipientBundleCost,
          recipientRouteEtaAfterTransfer,
          sourceRouteEtaAfterTransfer,
          sourceBaseRouteEta,
        };
      })
    );

    const best = evaluations
    .filter(Boolean)
    .sort((a, b) => (b.gain - a.gain) || (a.recipientBundleCost - b.recipientBundleCost))[0];

    if (!best) return null;

    return {
      ...best,
      routeEta: best.recipientRouteEtaAfterTransfer,
    };
  }

  // 🔥 NUEVO: sincronización local correcta
  _syncDriverOrders(driver) {
    driver.orders = Object.values(this._world.orders)
    .filter(o =>
    o.driver_id === driver.id &&
    ['assigned', 'on_the_way'].includes(o.status)
    )
    .map(o => o.id);
  }

  async run(simTime) {
    const minGain = this._getParam('transfer_min_gain_s', 10);
    const maxRouteEta = this._getParam('transfer_max_route_eta_s', 180);

    let transfers = 0;
    const maxIterations = this._getParam('transfer_max_iterations', 5);

    for (let iter = 0; iter < maxIterations; iter++) {

      let didTransfer = false;

      const drivers = Object.values(this._world.drivers);

      const routeCandidates = await Promise.all(
        drivers.map(async (driver) => ({
          driver,
          routeEta: await this._estimateRouteEta(driver),
                                       transferableTail: this._getTransferableTailOrders(driver, simTime),
        }))
      );

      const overloadedRoutes = routeCandidates.filter((route) =>
      Number.isFinite(route.routeEta) &&
      route.routeEta > maxRouteEta &&
      route.transferableTail.length > 0
      );

      if (overloadedRoutes.length === 0) break;

      for (const { driver, transferableTail, routeEta } of overloadedRoutes) {

        for (const orderId of transferableTail) {

          const bundleOrderIds = [orderId];

          const bestRecipient = await this._findBestRecipientForBundle({
            sourceDriver: driver,
            bundleOrderIds,
            simTime
          });

          if (!bestRecipient || bestRecipient.gain < minGain) continue;

          const targetDriver = this._world.drivers[bestRecipient.driver.id];
          if (!targetDriver) continue;

          const order = this._world.orders[orderId];
          if (!order) continue;

          // 🔥 aplicar transfer
          order.driver_id = targetDriver.id;
          order.assigned_at = simTime;
          order.last_transferred_at = simTime;

          // 🔥 sincronizar
          this._syncDriverOrders(driver);
          this._syncDriverOrders(targetDriver);

          // 🔥 replan inmediato
          await this._routingPlanner.replan(driver);
          await this._routingPlanner.replan(targetDriver);

          transfers++;
          didTransfer = true;

          break; // solo 1 orden por driver
        }

        if (didTransfer) break; // recomputar estado global
      }

      if (!didTransfer) break; // convergencia
    }

    return transfers;
  }
}
