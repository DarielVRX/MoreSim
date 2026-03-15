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


    // ─── 2. Drivers esperando pedido listo ─────────────────────
    for (const driver of Object.values(drivers)) {

      if (driver.status !== 'waiting_at_restaurant') continue;

      for (const orderId of driver.orders) {

        const order = orders[orderId];

        if (!order) continue;
        if (order.kitchen_status !== 'ready') continue;
        if (order.status !== 'assigned') continue;

        const restaurant = restaurants[order.restaurant_id];
        const customer   = customers[order.customer_id];

        if (!customer) continue;

        order.status = 'on_the_way';
        order.picked_up_at = simTime;

        order.pickup_wait_s =
        (order.pickup_wait_s ?? 0) +
        (order.kitchen_ready_at - (order.assigned_at ?? order.kitchen_ready_at));

        driver.status = 'moving_to_delivery';
        driver._arrival_type = 'at_customer';

        this._movement
        .setOrderRoute(driver, driver.pos, customer.pos)
        .then(({ distance_m }) => {
          order.route_distance_km =
          order.route_distance_km ?? distance_m / 1000;
          console.log("route created", driver.id)
        });

        this._onEvent({
          time: simTime,
          type: 'pickup',
          message: `🛵 ${driver.name} recogió pedido ${order.id} en ${restaurant?.name}`,
          orderId: order.id,
          driverId: driver.id
        });

        break;
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

    winner.orders.push(order.id);

    if (!winner.path || winner.path.length === 0 || winner.status === 'idle')
  {
      console.log("assign route", winner.id, restaurant.pos);

      winner.status = 'moving_to_pickup';
      winner._arrival_type = 'at_restaurant';

      await this._movement.setOrderRoute(
        winner,
        winner.pos,
        restaurant.pos,
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

    const { orders, restaurants } = this._world;

    if (type === 'at_restaurant') {

      driver.status = 'waiting_at_restaurant';

      const orderId =
      driver.orders.find(id => orders[id]?.status === 'assigned');

      const order =
      orderId ? orders[orderId] : null;

      const rest =
      order ? restaurants[order.restaurant_id] : null;

      this._onEvent({
        time: simTime,
        type: 'arrived_restaurant',
        message: `🏪 ${driver.name} llegó a ${rest?.name ?? 'comercio'} — esperando pedido`,
        driverId: driver.id
      });

      return;
    }

    if (type === 'at_customer') {

      const orderId =
      driver.orders.find(id => orders[id]?.status === 'on_the_way');

      if (!orderId) return;

      const order = orders[orderId];

      order.status = 'delivered';
      order.delivered_at = simTime;

      driver.orders =
      driver.orders.filter(id => id !== orderId);

      if (driver.orders.length > 0) {

        const nextOrderId = driver.orders[0];
        const nextOrder = orders[nextOrderId];
        const restaurant = restaurants[nextOrder.restaurant_id];

        driver.status = 'moving_to_pickup';
        driver._arrival_type = 'at_restaurant';

        if (nextOrder && restaurant) {
          this._movement.setOrderRoute(
            driver,
            driver.pos,
            restaurant.pos
          );
        }

      } else {

        driver.status = 'idle';

      }

      this._onEvent({
        time: simTime,
        type: 'delivered',
        message: `✅ ${driver.name} entregó pedido ${order.id}`,
        orderId: order.id,
        driverId: driver.id
      });

      // EVENTO: driver libera capacidad
      this.handleDriverLoadReduced(driver.id, simTime);

      return;
    }

    if (type === 'at_free_dest') {

      driver.status = 'waiting_at_restaurant';
      driver.idle_elapsed = 0;
    }
  }
}
