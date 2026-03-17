import { haversineMeters } from './GraphCache.js';

export class AssignmentUtils {
  constructor({ world, variables, onEvent }) {
    this._world = world;
    this._variables = variables;
    this._onEvent = onEvent ?? (() => {});
  }

  update({ world, variables, onEvent }) {
    if (world) this._world = world;
    if (variables) this._variables = variables;
    if (onEvent) this._onEvent = onEvent;
  }

  getSpeedMs(driver) {
    const speedKmh = Number.isFinite(driver?.speed_kmh) ? driver.speed_kmh : 30;
    const speedMs = Math.max(1, (speedKmh * 1000) / 3600);
    return speedMs;
  }

  getDeliverySla(customer) {
    return customer?.max_delivery_time_s ?? this._world?.params?.max_delivery_time_s ?? 1800;
  }

  estimateRemainingRouteEta(driver, simTime) {
    if (Number.isFinite(driver.remaining_route_eta)) return Math.max(0, driver.remaining_route_eta);
    if (Number.isFinite(driver.eta_sum)) return Math.max(0, driver.eta_sum);

    const expected = driver?._route_plan?.expected_duration_s;
    const started = driver?._route_plan?.started_at;
    if (Number.isFinite(expected) && Number.isFinite(started)) {
      return Math.max(0, expected - Math.max(0, simTime - started));
    }

    return 0;
  }

  emitRouteAudit(driver, simTime, destination, order = null) {
    const plan = driver._route_plan;
    if (!plan) return;

    const actualDuration = Math.max(0, simTime - (plan.started_at ?? simTime));
    const expectedDuration = plan.expected_duration_s;
    const delta = Number.isFinite(expectedDuration)
    ? actualDuration - expectedDuration
    : null;

    console.log(`[Audit] ${driver.name} completó ${plan.stop_type}. Real: ${actualDuration.toFixed(1)}s, Est: ${expectedDuration?.toFixed(1) ?? 'n/a'}s, Delta: ${delta?.toFixed(1) ?? 'n/a'}s`);

    this._onEvent({
      time: simTime,
      type: 'route_audit',
      message:
      `⏱️ ${driver.name} ${destination} (${plan.stop_type}:${plan.order_id}) ` +
      `real=${actualDuration.toFixed(1)}s est=${Number.isFinite(expectedDuration) ? expectedDuration.toFixed(1) : 'n/a'}s`,
                  driverId: driver.id,
                  orderId: order?.id ?? plan.order_id,
                  route_started_at: plan.started_at,
                  route_finished_at: simTime,
                  elapsed_s: actualDuration,
                  expected_s: expectedDuration,
                  delta_s: delta,
                  decision: plan.decision,
                  reason: plan.reason,
    });

    driver._route_plan = null;
  }

  isAtCustomer(driverPos, customerPos) {
    return haversineMeters(driverPos, customerPos) < 25;
  }
}
