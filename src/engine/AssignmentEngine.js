// src/engine/AssignmentEngine.js

import { pickBestDriver }   from '../scoring/scorer.js';
import { fetchOSRMRoute }   from './MovementEngine.js';
import { haversineMeters }  from './GraphCache.js';

export class AssignmentEngine {

  constructor({ variables, world, movementEngine, onEvent }) {
    this._variables      = variables;
    this._world          = world;
    this._movement       = movementEngine;
    this._onEvent        = onEvent ?? (() => {});
    this._assigning      = new Set();
  }

  updateVariables(vars) {
    this._variables = vars;
  }

  // ─────────────────────────────────────────────────────────────
  // TICK PRINCIPAL
  // SOLO gestiona cocina y pickups (NO asignaciones)
  // ─────────────────────────────────────────────────────────────
  tick(dtSim, simTime) {

    const { orders, restaurants, drivers, customers } = this._world;

    // ─── 1. Timers de cocina ───────────────────────────────────
    for (const order of Object.values(orders)) {

      if (order.status !== 'assigned') continue;
      if (order.kitchen_status !== 'preparing') continue;

      order._kitchen_elapsed = (order._kitchen_elapsed ?? 0) + dtSim;

      const restaurant = restaurants[order.restaurant_id];

      if (order._kitchen_elapsed >= (restaurant?.prep_time_s ?? 600)) {

        order.kitchen_status = 'ready';
        order.kitchen_ready_at = simTime;

        this._onEvent({
          time: simTime,
          type: 'kitchen_ready',
          message: `🍳 ${restaurant?.name ?? order.restaurant_id} — Pedido ${order.id} listo para retiro`,
          orderId: order.id
        });
      }
    }


    for (const driver of Object.values(drivers)) {

      if (driver.status !== 'waiting_at_restaurant') continue;

      const restaurantId = driver.current_restaurant_id;
      if (!restaurantId) continue;

      const restaurant = restaurants[restaurantId];

      const assignedOrders = driver.orders
      .map(id => orders[id])
      .filter(o =>
      o &&
      o.status === 'assigned' &&
      o.restaurant_id === restaurantId
      );

      if (assignedOrders.length === 0) continue;

      const readyOrders = assignedOrders.filter(o => o.kitchen_status === 'ready');
      const preparingOrders = assignedOrders.filter(o => o.kitchen_status !== 'ready');

      if (readyOrders.length === 0) continue;

      const readyOrder = readyOrders[0];
      const customerReady = customers[readyOrder.customer_id];

      if (preparingOrders.length === 0) {

        readyOrder.status = 'on_the_way';
        readyOrder.picked_up_at = simTime;

        // todos los pedidos que ya están en camino
        const deliverable = driver.orders
        .map(id => orders[id])
        .filter(o => o && o.status === 'on_the_way');

        if (deliverable.length === 0) continue;

        // elegir cliente más cercano
        let bestOrder = null;
        let bestDist = Infinity;

        for (const o of deliverable) {

          const cust = customers[o.customer_id];
          const dist = haversineMeters(driver.pos, cust.pos);

          if (dist < bestDist) {
            bestDist = dist;
            bestOrder = o;
          }
        }

        const nextCustomer = customers[bestOrder.customer_id];

        driver.status = 'moving_to_delivery';
        driver._arrival_type = 'at_customer';

        this._movement.setOrderRoute(
          driver,
          driver.pos,
          nextCustomer.pos
        );

        continue;
      }

      const preparingOrder = preparingOrders[0];

      const prepRemaining =
      (restaurant?.prep_time_s ?? 600) -
      (preparingOrder._kitchen_elapsed ?? 0);

      const speed = (driver.speed_kmh * 1000) / 3600;

      const distRestToCustomer =
      haversineMeters(restaurant.pos, customerReady.pos);

      const distCustomerToRest =
      haversineMeters(customerReady.pos, restaurant.pos);

      const deliverFirstTime =
      (distRestToCustomer + distCustomerToRest) / speed;

      if (prepRemaining > deliverFirstTime) {

        readyOrder.status = 'on_the_way';
        readyOrder.picked_up_at = simTime;

        driver.status = 'moving_to_delivery';
        driver._arrival_type = 'at_customer';

        this._movement.setOrderRoute(
          driver,
          driver.pos,
          customerReady.pos
        );

        this._onEvent({
          time: simTime,
          type: 'pickup',
          message: `🛵 ${driver.name} entrega primero pedido ${readyOrder.id}`,
          orderId: readyOrder.id,
          driverId: driver.id
        });
      }
    }
    // ─── Evaluar desvío para recoger otro pedido ─────────────────
    for (const driver of Object.values(drivers)) {

      if (driver.status !== 'moving_to_delivery') continue;

      const orderId =
      Object.values(orders)
      .find(o =>
      o.driver_id === driver.id &&
      o.status === 'on_the_way'
      )?.id;

      const activeOrder =
      Object.values(orders)
      .find(o =>
      o.driver_id === driver.id &&
      o.status === 'on_the_way'
      );
      if (!activeOrder) continue;

      const customer = customers[activeOrder.customer_id];

      // ETA actual al cliente
      const distToCustomer =
      haversineMeters(driver.pos, customer.pos);

      const speed = (driver.speed_kmh * 1000) / 3600;
      const etaDirect = distToCustomer / speed;

      const maxDelivery =
      customer.max_delivery_time_s ??
      this._world.params.max_delivery_time_s ??
      1800;

      const assignedOrders = driver.orders
      .map(id => orders[id])
      .filter(o =>
      o &&
      o.status === 'assigned' &&
      o.kitchen_status === 'ready'
      );

      for (const order of assignedOrders) {

        const rest = restaurants[order.restaurant_id];

        const distToRest =
        haversineMeters(driver.pos, rest.pos);

        const distRestToCustomer =
        haversineMeters(rest.pos, customer.pos);

        const etaDetour =
        (distToRest + distRestToCustomer) / speed;

        // decisión
        if (etaDetour <= maxDelivery) {

          driver.status = 'moving_to_pickup';
          driver._arrival_type = 'at_restaurant';
          driver.current_restaurant_id = rest.id;

          this._movement.setOrderRoute(
            driver,
            driver.pos,
            rest.pos
          );

          this._onEvent({
            time: simTime,
            type: 'detour_pickup',
            message: `📦 ${driver.name} recoge ${order.id} antes de entregar`,
            orderId: order.id,
            driverId: driver.id
          });

          break;
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // EVENTO: PEDIDO CREADO
  // ─────────────────────────────────────────────────────────────
  handleOrderCreated(orderId, simTime) {

    const order = this._world.orders[orderId];
    if (!order) return;

    this._tryAssign(order, simTime);
  }

  // ─────────────────────────────────────────────────────────────
  // EVENTO: DRIVER LIBERA CAPACIDAD
  // ─────────────────────────────────────────────────────────────
  handleDriverLoadReduced(driverId, simTime) {

    const { orders } = this._world;

    const queued = Object.values(orders)
    .filter(o => o.status === 'queued' && o.triggered);

    if (queued.length === 0) return;

    queued.sort((a,b)=> (a.created_at ?? 0) - (b.created_at ?? 0));

    this._tryAssign(queued[0], simTime);
  }

  // ─────────────────────────────────────────────────────────────
  // INTENTO CONTROLADO DE ASIGNACIÓN
  // ─────────────────────────────────────────────────────────────
  _tryAssign(order, simTime) {

    if (order.status !== 'queued') return;
    if (!order.triggered) return;

    if (this._assigning.has(order.id)) return;

    this._assigning.add(order.id);

    this._assignOrder(order, simTime)
    .finally(() => this._assigning.delete(order.id));
  }

  // ─────────────────────────────────────────────────────────────
  // ASIGNACIÓN PRINCIPAL
  // ─────────────────────────────────────────────────────────────
  async _assignOrder(order, simTime) {

    const { drivers, restaurants, customers } = this._world;

    const restaurant = restaurants[order.restaurant_id];
    const customer   = customers[order.customer_id];

    if (!restaurant || !customer) return;

    if (!Number.isFinite(restaurant?.pos?.lat)) return;
    if (!Number.isFinite(customer?.pos?.lat)) return;

    // ─── Restricción distancia cliente ────────────────────────

    const distKm =
    haversineMeters(restaurant.pos, customer.pos) / 1000;

    if (customer.max_distance_km > 0 && distKm > customer.max_distance_km) {

      this._onEvent({
        time: simTime,
        type: 'no_driver',
        message: `⛔ Pedido ${order.id} cancelado — distancia ${distKm.toFixed(1)} km supera máximo`,
                    orderId: order.id
      });

      order.status = 'cancelled';
      return;
    }

    // ─── Drivers disponibles ──────────────────────────────────

    const driverList = Object.values(drivers).filter(driver => {

      const activeOrders = Array.isArray(driver.orders)
      ? driver.orders.length
      : 0;

      const maxOrders = Number.isFinite(driver.max_orders)
      ? driver.max_orders
      : 1;

      return (
        activeOrders < maxOrders &&
        Number.isFinite(driver?.pos?.lat)
      );
    });

    if (driverList.length === 0) {

      this._onEvent({
        time: simTime,
        type: 'no_driver',
        message: `⚠️ Pedido ${order.id} sin driver disponible`,
        orderId: order.id
      });

      return;
    }

    // ─── ETA driver → restaurante ─────────────────────────────

    await Promise.all(driverList.map(async (driver)=>{

      try {

        const { duration_s } =
        await fetchOSRMRoute(driver.pos, restaurant.pos);

        driver._eta_to_restaurant_s = duration_s;

      } catch {

        const dist_m =
        haversineMeters(driver.pos, restaurant.pos);

        driver._eta_to_restaurant_s =
        dist_m / ((driver.speed_kmh * 1000) / 3600);
      }
    }));

    // ─── Scoring ──────────────────────────────────────────────

    const { winner, results } =
    pickBestDriver(
      driverList,
      order,
      restaurant,
      customer,
      this._variables,
      this._world
    );

    if (!winner) return;

    const activeOrders = Array.isArray(winner.orders)
    ? winner.orders.length
    : 0;

    const maxOrders = Number.isFinite(winner.max_orders)
    ? winner.max_orders
    : 1;

    if (activeOrders >= maxOrders) {
      return;
    }

    order.assignment_score = results.find(
      r => r.driver.id === winner.id
    )?.score ?? 0;

    // ─── Mutar pedido ─────────────────────────────────────────

    order.status = 'assigned';
    order.driver_id = winner.id;
    order.assigned_at = simTime;
    order.score_breakdown = results;
    order._kitchen_elapsed = 0;

    // ─── Distancia ruta ───────────────────────────────────────

    try {

      const { distance_m } =
      await fetchOSRMRoute(restaurant.pos, customer.pos);

      order.route_distance_km = distance_m / 1000;

    } catch {

      order.route_distance_km =
      haversineMeters(restaurant.pos, customer.pos) / 1000;
    }

    // ─── Mutar driver ─────────────────────────────────────────

    if (!winner.orders.includes(order.id)) {
      winner.orders.push(order.id);
    }

    winner.orders.sort((a, b) => {
      const oa = this._world.orders[a];
      const ob = this._world.orders[b];

      return (ob.assignment_score ?? 0) - (oa.assignment_score ?? 0);
    });

    if (!winner.path || winner.path.length === 0 || winner.status === 'idle')
  {
      console.log("assign route", winner.id, restaurant.pos);

      winner.status = 'moving_to_pickup';
      winner._arrival_type = 'at_restaurant';
      winner.current_restaurant_id = restaurant.id;

      await this._movement.setOrderRoute(
        winner,
        winner.pos,
        restaurant.pos
      );
      console.log("route created", winner.id)

    }

    this._onEvent({
      time: simTime,
      type: 'assigned',
      message: `📦 Pedido ${order.id} → ${winner.name}`,
      orderId: order.id,
      driverId: winner.id,
      results
    });
  }

  // ─────────────────────────────────────────────────────────────
  // DRIVER ARRIVED
  // ─────────────────────────────────────────────────────────────
  handleDriverArrived(driver, type, simTime) {

    const { orders, restaurants, customers } = this._world;
    if (type === 'at_restaurant') {

      driver.status = 'waiting_at_restaurant';

      const restaurantId = driver.current_restaurant_id;

      const rest = restaurants[restaurantId];

      this._onEvent({
        time: simTime,
        type: 'arrived_restaurant',
        message: `🏪 ${driver.name} llegó a ${rest?.name ?? 'comercio'} — esperando pedido`,
        driverId: driver.id
      });

      return;
    }

    if (type === 'at_customer') {

      const order =
      Object.values(orders).find(o =>
      o.driver_id === driver.id &&
      o.status === 'on_the_way' &&
      haversineMeters(driver.pos, customers[o.customer_id].pos) < 25
      );

      if (!order) return;

      const orderId = order.id;

      order.status = 'delivered';
      order.delivered_at = simTime;
      driver._arrival_type = null;

      driver.orders =
      driver.orders.filter(id => id !== orderId);

      this._onEvent({
        time: simTime,
        type: 'delivered',
        message: `✅ ${driver.name} entregó pedido ${order.id}`,
        orderId: order.id,
        driverId: driver.id
      });

      // liberar capacidad para asignaciones nuevas
      this.handleDriverLoadReduced(driver.id, simTime);

      // buscar entregas restantes del driver
      const remainingDeliveries =
      Object.values(orders)
      .filter(o =>
      o.driver_id === driver.id &&
      o.status === 'on_the_way'
      );

      if (remainingDeliveries.length > 0) {

        let best = null;
        let bestDist = Infinity;

        for (const o of remainingDeliveries) {

          const cust = customers[o.customer_id];
          const dist = haversineMeters(driver.pos, cust.pos);

          if (dist < bestDist) {
            bestDist = dist;
            best = o;
          }
        }

        const customer = customers[best.customer_id];

        driver.status = 'moving_to_delivery';
        driver._arrival_type = 'at_customer';

        this._movement.setOrderRoute(
          driver,
          driver.pos,
          customer.pos
        );

        return;
      }

      const remaining =
      Object.values(orders)
      .filter(o =>
      o.driver_id === driver.id &&
      (o.status === 'on_the_way' || o.status === 'assigned')
      );

      // 1️⃣ pedidos ya recogidos
      const deliverable =
      remaining.filter(o => o.status === 'on_the_way');

      if (deliverable.length > 0) {

        // elegir cliente más cercano
        let best = null;
        let bestDist = Infinity;

        for (const o of deliverable) {

          const cust = this._world.customers[o.customer_id];
          const dist = haversineMeters(driver.pos, cust.pos);

          if (dist < bestDist) {
            bestDist = dist;
            best = o;
          }
        }

        const customer = this._world.customers[best.customer_id];

        driver.status = 'moving_to_delivery';
        driver._arrival_type = 'at_customer';

        this._movement.setOrderRoute(
          driver,
          driver.pos,
          customer.pos
        );

        return;

      }

      // 2️⃣ pedidos que faltan por recoger
      const pickups =
      Object.values(orders)
      .filter(o =>
      o.driver_id === driver.id &&
      o.status === 'assigned'
      );

      let nextPickup = null;
      let bestDist = Infinity;

      for (const o of pickups) {

        const rest = restaurants[o.restaurant_id];
        const dist = haversineMeters(driver.pos, rest.pos);

        if (dist < bestDist) {
          bestDist = dist;
          nextPickup = o;
        }
      }

      if (nextPickup) {

        const restaurant = restaurants[nextPickup.restaurant_id];

        driver.status = 'moving_to_pickup';
        driver._arrival_type = 'at_restaurant';
        driver.current_restaurant_id = restaurant.id;

        this._movement.setOrderRoute(
          driver,
          driver.pos,
          restaurant.pos
        );

        return;

      }

      // 3️⃣ nada más que hacer
      driver.status = 'idle';
      return;

      return;
    }

    if (type === 'at_free_dest') {

      driver.status = 'waiting_at_restaurant';
      driver.idle_elapsed = 0;
    }
  }
}
