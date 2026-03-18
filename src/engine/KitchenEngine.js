import { ensureOrderTiming, getPrepElapsedTime, getRemainingPrepTime } from './OrderTiming.js';

export class KitchenEngine {
  constructor({ world, onEvent }) {
    this._world = world;
    this._onEvent = onEvent ?? (() => {});
  }

  update({ world, onEvent }) {
    if (world) this._world = world;
    if (onEvent) this._onEvent = onEvent;
  }

  tick(dtSim, simTime) {
    const { orders, restaurants } = this._world;

    for (const order of Object.values(orders)) {
      const isCooking =
        order.kitchen_status === 'preparing' &&
        order.picked_up_at == null;

      if (!isCooking) continue;

      const restaurant = restaurants[order.restaurant_id];
      const timing = ensureOrderTiming(order, this._world, simTime);
      order._kitchen_elapsed = getPrepElapsedTime(order, this._world, simTime);

      if (getRemainingPrepTime(order, this._world, simTime) <= 0) {
        order.kitchen_status = 'ready';
        order.kitchen_ready_at = timing?.prepReadyAt ?? simTime;
        order._kitchen_elapsed = timing?.prepTimeS ?? order._kitchen_elapsed;

        this._onEvent({
          time: simTime,
          type: 'kitchen_ready',
          message: `🍳 ${restaurant?.name ?? order.restaurant_id} — Pedido ${order.id} listo para retiro`,
          orderId: order.id,
        });
        console.log(`[Kitchen] Pedido ${order.id} listo tras ${order._kitchen_elapsed.toFixed(1)}s`);
      }
    }
  }
}
