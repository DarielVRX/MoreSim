import { haversineMeters } from './GraphCache.js';

export class RouteInsertionSimulator {
  constructor({ world, routingPlanner, assignmentUtils, estimateTravelTime, debug = true }) {
    this._world = world;
    this._routingPlanner = routingPlanner;
    this._utils = assignmentUtils;
    this._estimateTravelTime = estimateTravelTime;
    this._debug = debug;
  }

  _log(tag, data) {
    if (!this._debug) return;
    console.log(`[Sim:${tag}]`, data);
  }

  _isSameStop(a, b) {
    if (!a || !b) return false;
    return a.type === b.type && (a.orderId ?? null) === (b.orderId ?? null);
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
          stops.push({ type: 'pickup', orderId: order.id, pos: restaurant.pos });
        }
      }

      if (orderState.status === 'on_the_way') {
        const customer = customers[order.customer_id];
        if (customer?.pos) {
          stops.push({ type: 'delivery', orderId: order.id, pos: customer.pos });
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
    const speedMs = this._utils.getSpeedMs(driver);

    return stops
    .filter(s => s.type === 'delivery')
    .filter(stop => {
      const order = orders[stop.orderId];
      const customer = customers[order?.customer_id];
      const state = simState[stop.orderId];

      if (!order || !customer || !state) return false;

      const max = this._utils.getDeliverySla(customer);
      const elapsed = Math.max(0, simNow - (state.pickedUpAt ?? simNow));
      const remaining = max - elapsed;
      const eta = haversineMeters(currentPos, customer.pos) / speedMs;

      const urgent = eta >= remaining;

      if (urgent) {
        this._log('urgent_detected', {
          driver: driver.name,
          order: stop.orderId,
          eta: eta.toFixed(1),
                  remaining: remaining.toFixed(1),
        });
      }

      return urgent;
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

    this._log('start', {
      driver: driver.name,
      order: order.id,
      prefixStops: prefixToViable.length,
      viableStop,
    });

    for (let i = 0; i < maxIterations; i++) {

      let activeStops = this._buildActiveStopsFromState(simState);

      if (activeStops.length === 0) break;

      // evitar loops por distancia cero
      activeStops = activeStops.filter(s =>
      haversineMeters(currentPos, s.pos) > 1
      );

      if (!pickupInserted && reachedViable) {
        const restaurant = this._world.restaurants[order.restaurant_id];
        if (restaurant?.pos) {
          activeStops = [
            { type: 'pickup', orderId: order.id, pos: restaurant.pos },
            ...activeStops.filter(s => !(s.type === 'pickup' && s.orderId === order.id)),
          ];
        }
      }

      const urgent = this._findUrgentDeliveryStops(
        driver,
        currentPos,
        activeStops,
        simState,
        simNow
      );

      let nextStop = null;
      let decision = 'nearest';

      if (!reachedViable && prefixCursor < prefixToViable.length) {
        const expected = prefixToViable[prefixCursor];
        nextStop = activeStops.find(s => this._isSameStop(s, expected)) ?? null;
        decision = 'prefix';
      }

      if (!pickupInserted && reachedViable && !nextStop) {
        nextStop = activeStops.find(s => s.type === 'pickup' && s.orderId === order.id) ?? null;
        decision = 'force_pickup';
      }

      if (!nextStop) {
        nextStop = urgent.length > 0
        ? this._closestStop(currentPos, urgent)
        : this._closestStop(currentPos, activeStops);

        decision = urgent.length > 0 ? 'urgent' : 'nearest';
      }

      if (!nextStop) break;

      const travelTime =
      await this._estimateTravelTime(currentPos, nextStop.pos, driver);

      this._log('step', {
        driver: driver.name,
        step: i,
        decision,
        nextStop,
        travelTime: travelTime.toFixed(1),
                simNow: simNow.toFixed(1),
      });

      simNow += travelTime;
      currentPos = { ...nextStop.pos };

      const state = simState[nextStop.orderId];
      if (!state) continue;

      if (nextStop.type === 'pickup') {
        state.status = 'on_the_way';
        state.pickedUpAt = simNow;

        this._log('pickup', {
          driver: driver.name,
          order: nextStop.orderId,
          time: simNow.toFixed(1),
        });

        if (nextStop.orderId === order.id) {
          pickupInserted = true;
        }

      } else {

        state.status = 'delivered';

        this._log('delivery', {
          driver: driver.name,
          order: nextStop.orderId,
          time: simNow.toFixed(1),
        });

        if (nextStop.orderId === order.id) {
          etaToNewCustomer = simNow - simTime;
        }
      }

      if (!reachedViable && prefixCursor < prefixToViable.length &&
        this._isSameStop(nextStop, prefixToViable[prefixCursor])) {
        prefixCursor++;
        }

        if (!reachedViable && this._isSameStop(nextStop, viableStop)) {
          reachedViable = true;
        }
    }

    // SLA validation
    const newCustomer = this._world.customers[order.customer_id];
    const maxSla = this._utils.getDeliverySla(newCustomer);

    const validNew =
    Number.isFinite(etaToNewCustomer) &&
    etaToNewCustomer <= maxSla;

    const slaBreaches = [];

    for (const orderId of driver.orders ?? []) {
      const o = this._world.orders[orderId];
      const state = simState[orderId];
      if (!o || !state || o.status !== 'on_the_way') continue;

      const customer = this._world.customers[o.customer_id];
      const max = this._utils.getDeliverySla(customer);

      const deliveredAt = state.status === 'delivered' ? simNow : Infinity;
      const elapsed = deliveredAt - state.pickedUpAt;

      if (!Number.isFinite(elapsed) || elapsed > max) {
        slaBreaches.push(orderId);

        this._log('sla_breach', {
          driver: driver.name,
          order: orderId,
          elapsed,
          max,
        });
      }
    }

    const valid =
    Number.isFinite(etaToNewCustomer) &&
    validNew &&
    slaBreaches.length === 0;

    this._log('result', {
      driver: driver.name,
      eta: etaToNewCustomer,
      valid,
      breaches: slaBreaches.length,
    });

    return {
      valid,
      etaToNewCustomer,
      slaBreaches,
    };
  }

  async evaluate({ topDrivers, order, simTime }) {
    this._log('evaluate_start', {
      order: order.id,
      candidates: topDrivers.length,
    });

    return Promise.all(
      topDrivers.map(async (candidate) => ({
        ...candidate,
        ...(await this._simulateDriverWithOrder({
          driver: candidate.driver,
          order,
          viableStop: candidate.viableStop,
          simTime,
        })),
      }))
    );
  }
}
