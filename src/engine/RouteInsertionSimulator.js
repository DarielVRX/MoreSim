import { getRemainingPrepTime } from './OrderTiming.js';
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

  _buildSimulationState(driver, candidateOrderId, simTime, includeCurrentOrderInState = false) {
    const state = {};
    const orders = this._world.orders;

    for (const orderId of driver.orders ?? []) {
      if (!includeCurrentOrderInState && orderId === candidateOrderId) continue;
      const o = orders[orderId];
      if (!o) continue;
      state[orderId] = {
        orderId,
        status: o.status,
        pickedUpAt: o.picked_up_at,
      };
    }

    if (!state[candidateOrderId]) {
      state[candidateOrderId] = {
        orderId: candidateOrderId,
        status: 'assigned',
        pickedUpAt: null,
        assignedAt: simTime,
      };
    }

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

      const customer = customers[order.customer_id];
      if (customer?.pos) {
        stops.push({ type: 'delivery', orderId: order.id, pos: customer.pos });
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
      return urgent;
    });
  }

  _estimateRestaurantWait(orderId, arrivalTime, simTime) {
    const order = this._world.orders[orderId];
    if (!order) return 0;

    return getRemainingPrepTime(order, this._world, arrivalTime);
  }

  async _simulateDriverWithOrder({ driver, order, viableStop, simTime, includeCurrentOrderInState = false }) {
    const simState = this._buildSimulationState(driver, order.id, simTime, includeCurrentOrderInState);

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

      activeStops = activeStops.filter(s => {
        if (s.type === 'delivery') {
          return simState[s.orderId]?.status === 'on_the_way';
        }
        return true;
      });

      if (activeStops.length === 0) break;

      if (!pickupInserted && reachedViable) {
        const restaurant = this._world.restaurants[order.restaurant_id];
        if (restaurant?.pos) {
          activeStops = [
            { type: 'pickup', orderId: order.id, pos: restaurant.pos },
            ...activeStops.filter(s => !(s.type === 'pickup' && s.orderId === order.id)),
          ];
        }
      }

      const urgent = this._findUrgentDeliveryStops(driver, currentPos, activeStops, simState, simNow);

      let nextStop = null;

      if (!reachedViable && prefixCursor < prefixToViable.length) {
        const expected = prefixToViable[prefixCursor];
        nextStop = activeStops.find(s => this._isSameStop(s, expected)) ?? null;
      }

      if (!pickupInserted && reachedViable) {
        const pickupStop = activeStops.find(
          s => s.type === 'pickup' && s.orderId === order.id
        );

        if (pickupStop) {
          nextStop = pickupStop;
        }
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
        const waitAtRestaurant = this._estimateRestaurantWait(nextStop.orderId, simNow, simTime);
        simNow += waitAtRestaurant;

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

      if (!reachedViable && prefixCursor < prefixToViable.length &&
        this._isSameStop(nextStop, prefixToViable[prefixCursor])) {
        prefixCursor++;
      }

      if (!reachedViable && this._isSameStop(nextStop, viableStop)) {
        reachedViable = true;
      }
    }

    const newCustomer = this._world.customers[order.customer_id];
    const maxSla = this._utils.getDeliverySla(newCustomer);
    const newOrderDelay = Math.max(0, etaToNewCustomer - maxSla);

    const slaBreaches = [];

    for (const orderId of driver.orders ?? []) {
      if (orderId === order.id && !includeCurrentOrderInState) continue;

      const o = this._world.orders[orderId];
      const state = simState[orderId];
      if (!o || !state || o.status !== 'on_the_way') continue;

      const customer = this._world.customers[o.customer_id];
      const max = this._utils.getDeliverySla(customer);

      const deliveredAt = state.status === 'delivered' ? simNow : Infinity;
      const elapsed = deliveredAt - state.pickedUpAt;

      if (!Number.isFinite(elapsed) || elapsed > max) {
        slaBreaches.push(orderId);
      }
    }

    const validExisting = slaBreaches.length === 0;
    const valid = Number.isFinite(etaToNewCustomer) && validExisting && newOrderDelay === 0;

    return {
      valid,
      validExisting,
      etaToNewCustomer,
      newOrderDelay,
      slaBreaches,
      totalCost: etaToNewCustomer + newOrderDelay,
    };
  }

  async evaluate({ topDrivers, order, simTime, options = {} }) {
    return Promise.all(
      topDrivers.map(async (candidate) => ({
        ...candidate,
        ...(await this._simulateDriverWithOrder({
          driver: candidate.driver,
          order,
          viableStop: candidate.viableStop,
          simTime,
          includeCurrentOrderInState: options.includeCurrentOrderInState === true,
        })),
      }))
    );
  }
}
