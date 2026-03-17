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
      if (order.status !== 'assigned') continue;
      if (order.kitchen_status !== 'preparing') continue;

      order._kitchen_elapsed = (order._kitchen_elapsed ?? 0) + dtSim;
      const restaurant = restaurants[order.restaurant_id];
      const prepTime = restaurant?.prep_time_s ?? 600;

      if (order._kitchen_elapsed >= prepTime) {
        order.kitchen_status = 'ready';
        order.kitchen_ready_at = simTime;

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
