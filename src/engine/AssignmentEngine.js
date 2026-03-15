// src/engine/AssignmentEngine.js
//
// Orquesta la asignación de pedidos:
//   1. Por cada pedido en estado 'queued' que ya fue disparado (triggered=true),
//      obtiene ETAs desde cada driver candidato al restaurante via OSRM.
//   2. Llama al scorer para elegir el mejor driver.
//   3. Muta el pedido y el driver.
//   4. Emite eventos al log.
//
// También gestiona las transiciones de estado de cocina (preparing → ready)
// y de entrega (at_restaurant → on_the_way → delivered).

import { pickBestDriver }   from '../scoring/scorer.js';
import { fetchOSRMRoute }   from './MovementEngine.js';
import { haversineMeters }  from './GraphCache.js';

export class AssignmentEngine {
  constructor({ variables, world, movementEngine, onEvent }) {
    this._variables      = variables;       // variables activas con pesos
    this._world          = world;           // ref mutable al WorldState
    this._movement       = movementEngine;
    this._onEvent        = onEvent ?? (() => {});
    this._assigning      = new Set();       // pedidos en proceso de asignación (async)
  }

  updateVariables(vars) { this._variables = vars; }

  // ─── Tick principal ────────────────────────────────────────────────────────
  // Llamado por useSimulation en cada tick del SimClock.
  tick(dtSim, simTime) {
    const { orders, restaurants, drivers, customers } = this._world;

    // 1. Avanzar temporizadores de cocina
    for (const order of Object.values(orders)) {
      if (order.status === 'assigned' && order.kitchen_status === 'preparing') {
        order._kitchen_elapsed = (order._kitchen_elapsed ?? 0) + dtSim;
        const restaurant = restaurants[order.restaurant_id];
        if (order._kitchen_elapsed >= (restaurant?.prep_time_s ?? 600)) {
          order.kitchen_status   = 'ready';
          order.kitchen_ready_at = simTime;
          this._onEvent({
            time:    simTime,
            type:    'kitchen_ready',
            message: `🍳 ${restaurant?.name ?? order.restaurant_id} — Pedido ${order.id} listo para retiro`,
            orderId: order.id,
          });
        }
      }
    }

    // 2. Drivers esperando en restaurante — verificar si el pedido está listo
    for (const driver of Object.values(drivers)) {
      if (driver.status !== 'waiting_at_restaurant') continue;
      // Buscar el pedido asignado que está ready
      for (const orderId of driver.orders) {
        const order = orders[orderId];
        if (!order || order.kitchen_status !== 'ready' || order.status !== 'assigned') continue;
        const restaurant = restaurants[order.restaurant_id];
        const customer   = customers[order.customer_id];
        if (!customer) continue;

        order.status    = 'on_the_way';
        order.picked_up_at = simTime;
        order.pickup_wait_s = (order.pickup_wait_s ?? 0) +
          (order.kitchen_ready_at - (order.assigned_at ?? order.kitchen_ready_at));

        driver.status         = 'moving_to_delivery';
        driver._arrival_type  = 'at_customer';

        this._movement.setOrderRoute(driver, driver.pos, customer.pos).then(({ distance_m }) => {
          order.route_distance_km = order.route_distance_km ?? (distance_m / 1000);
        });

        this._onEvent({
          time:    simTime,
          type:    'pickup',
          message: `🛵 ${driver.name} recogió pedido ${order.id} en ${restaurant?.name}`,
          orderId: order.id,
          driverId: driver.id,
        });
        break;
      }
    }

    // 3. Pedidos disparados en cola → intentar asignar (async, evitar doble-asignación)
    for (const order of Object.values(orders)) {
      if (order.status !== 'queued') continue;
      if (!order.triggered) continue;
      if (this._assigning.has(order.id)) continue;
      this._assigning.add(order.id);
      this._assignOrder(order, simTime).finally(() => this._assigning.delete(order.id));
    }
  }

  // ─── Asignación asíncrona ─────────────────────────────────────────────────
  async _assignOrder(order, simTime) {
    const { drivers, restaurants, customers } = this._world;
    const restaurant = restaurants[order.restaurant_id];
    const customer   = customers[order.customer_id];
    // Restricción distancia comercio→cliente
    const distKm = haversineMeters(restaurant.pos, customer.pos) / 1000;
    if (customer.max_distance_km > 0 && distKm > customer.max_distance_km) {
      this._onEvent({
        time:    simTime,
        type:    'no_driver',
        message: `⛔ Pedido ${order.id} cancelado — distancia ${distKm.toFixed(1)} km supera máximo del cliente (${customer.max_distance_km} km)`,
                    orderId: order.id,
      });
      order.status = 'cancelled';
      return;
    }
    if (!restaurant || !customer) return;

    const driverList = Object.values(drivers);

    // Pre-calcular ETA de cada driver al restaurante
    await Promise.all(driverList.map(async (driver) => {
      try {
        const { duration_s } = await fetchOSRMRoute(driver.pos, restaurant.pos);
        driver._eta_to_restaurant_s = duration_s;
      } catch {
        // Fallback euclidiano
        const dist_m = haversineMeters(driver.pos, restaurant.pos);
        driver._eta_to_restaurant_s = dist_m / ((driver.speed_kmh * 1000) / 3600);
      }
    }));

    const { winner, results } = pickBestDriver(
      driverList, order, restaurant, customer, this._variables, this._world
    );

    if (!winner) {
      this._onEvent({
        time:    simTime,
        type:    'no_driver',
        message: `⚠️ Pedido ${order.id} sin driver disponible`,
        orderId: order.id,
      });
      return;
    }

    // Mutar pedido
    order.status      = 'assigned';
    order.driver_id   = winner.id;
    order.assigned_at = simTime;
    order.score_breakdown = results;
    order._kitchen_elapsed = 0;

    // Distancia comercio→cliente (para métrica de km muertos)
    try {
      const { distance_m } = await fetchOSRMRoute(restaurant.pos, customer.pos);
      order.route_distance_km = distance_m / 1000;
    } catch {
      order.route_distance_km = haversineMeters(restaurant.pos, customer.pos) / 1000;
    }

    // Mutar driver
    winner.orders.push(order.id);
    winner.status        = 'moving_to_pickup';
    winner._arrival_type = 'at_restaurant';

    // ETA al restaurante → sumarlo al eta_sum del driver
    winner.eta_sum += winner._eta_to_restaurant_s ?? 0;

    // Calcular y asignar ruta al restaurante
    await this._movement.setOrderRoute(winner, winner.pos, restaurant.pos);

    this._onEvent({
      time:     simTime,
      type:     'assigned',
      message:  `📦 Pedido ${order.id} → ${winner.name} (score: ${results.find(r => r.driver.id === winner.id)?.score ?? '?'})`,
      orderId:  order.id,
      driverId: winner.id,
      results,
    });
  }

  // ─── Callback cuando un driver llega a su destino ─────────────────────────
  // Llamado por MovementEngine vía onDriverArrived
  handleDriverArrived(driver, type, simTime) {
    const { orders, restaurants } = this._world;

    if (type === 'at_restaurant') {
      driver.status = 'waiting_at_restaurant';
      const orderId = driver.orders.find(id => orders[id]?.status === 'assigned');
      const order   = orderId ? orders[orderId] : null;
      const rest    = order   ? restaurants[order.restaurant_id] : null;
      this._onEvent({
        time:    simTime,
        type:    'arrived_restaurant',
        message: `🏪 ${driver.name} llegó a ${rest?.name ?? 'comercio'} — esperando pedido`,
        driverId: driver.id,
      });
      return;
    }

    if (type === 'at_customer') {
      const orderId = driver.orders.find(id => orders[id]?.status === 'on_the_way');
      if (!orderId) return;
      const order = orders[orderId];
      order.status       = 'delivered';
      order.delivered_at = simTime;
      driver.orders      = driver.orders.filter(id => id !== orderId);
      driver.eta_sum     = Math.max(0, driver.eta_sum - (driver._eta_to_restaurant_s ?? 0));

      // Calcular km muertos de esta entrega:
      // km_muertos = distancia_real_recorrida_para_este_pedido - route_distance_km
      // (puede ser negativo si tomó un camino más corto que la ruta directa)
      // Por simplificación: total_distance acumulado menos route_distance
      // En una implementación más precisa se trackearía por pedido.
      if (order.route_distance_km) {
        // Estimación: driver recorrió ETA_restaurant + route_distance
        const etaDistKm = (driver._eta_to_restaurant_s ?? 0) * (driver.speed_kmh / 3600);
        const totalForOrder = etaDistKm + (order.route_distance_km ?? 0);
        // Los "extra" vs ruta directa son los muertos
        // Nota: este cálculo es una aproximación; para precisión real
        // habría que trackear odómetro por pedido individualmente.
        driver.metrics.dead_km += Math.max(0, etaDistKm);
      }

      driver.status = driver.orders.length > 0 ? 'moving_to_pickup' : 'idle';
      driver.idle_elapsed = 0;

      this._onEvent({
        time:     simTime,
        type:     'delivered',
        message:  `✅ ${driver.name} entregó pedido ${order.id}`,
        orderId:  order.id,
        driverId: driver.id,
      });
      return;
    }

    if (type === 'at_free_dest') {
      driver.status       = 'waiting_at_restaurant';
      driver.idle_elapsed = 0;  // ← línea nueva
    }
  }
}
