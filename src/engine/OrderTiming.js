export function getOrderPrepTimeS(world, order) {
  const restaurant = world?.restaurants?.[order?.restaurant_id];
  return restaurant?.prep_time_s ?? 600;
}

export function ensureOrderTiming(order, world, simTime = 0) {
  if (!order) return null;

  const prepTimeS = getOrderPrepTimeS(world, order);
  const prepStartedAt = Number.isFinite(order.prep_started_at)
    ? order.prep_started_at
    : Number.isFinite(order.triggered_at)
      ? order.triggered_at
      : simTime;

  order.prep_started_at = prepStartedAt;
  order.prep_ready_at_estimate = prepStartedAt + prepTimeS;

  return {
    prepTimeS,
    prepStartedAt,
    prepReadyAt: order.prep_ready_at_estimate,
  };
}

export function getRemainingPrepTime(order, world, atTime = 0) {
  if (!order || order.kitchen_status === 'ready') return 0;

  const timing = ensureOrderTiming(order, world, atTime);
  if (!timing) return 0;

  return Math.max(0, timing.prepReadyAt - atTime);
}

export function getPrepElapsedTime(order, world, simTime = 0) {
  const timing = ensureOrderTiming(order, world, simTime);
  if (!timing) return 0;
  return Math.max(0, Math.min(timing.prepTimeS, simTime - timing.prepStartedAt));
}
