export class MovementEngine {
  constructor({ world, assignmentEngine, debug = true, tickRateMs = 1000 } = {}) {
    this._pendingPaths = new Map();
    this._debug = debug;

    // 🔥 NUEVO
    this._world = world;
    this._assignment = assignmentEngine;
    this._tickRateMs = tickRateMs;
    this._interval = null;
  }

  _log(tag, data = {}, level = 'log') {
    if (!this._debug) return;
    log(tag, data, level);
  }

  // ─────────────────────────────────────────────
  // 🔥 AUTO START
  // ─────────────────────────────────────────────
  start() {
    if (this._interval) return;

    this._log('engine_start', { tickRateMs: this._tickRateMs });

    this._interval = setInterval(() => {
      this._tickInternal(1); // 1s sim
    }, this._tickRateMs);
  }

  stop() {
    if (!this._interval) return;
    clearInterval(this._interval);
    this._interval = null;
  }

  // ─────────────────────────────────────────────
  async setOrderRoute(driver, from, to) {
    try {
      const { path, distance_m, duration_s } = await fetchOSRMRoute(from, to);

      driver.path = path;
      driver.path_index = 0;
      driver.segment_elapsed = 0;
      driver.stop_elapsed = 0;
      driver.stop_duration = 0;

      this._log('route_set', {
        driver: driver.name,
        points: path.length,
      });

      return { distance_m, duration_s };

    } catch (e) {
      this._log('route_fallback', { driver: driver.name }, 'warn');

      driver.path = [from, to];
      driver.path_index = 0;
      driver.segment_elapsed = 0;

      const dist = haversineMeters(from, to);
      const speed = ((driver.speed_kmh ?? 30) * 1000) / 3600;

      return {
        distance_m: dist,
        duration_s: dist / speed,
      };
    }
  }

  // ─────────────────────────────────────────────
  // 🔥 INTERNAL LOOP (CLAVE)
  // ─────────────────────────────────────────────
  _tickInternal(dtSim) {
    if (!this._world) return;

    const drivers = Object.values(this._world.drivers);
    const restaurants = Object.values(this._world.restaurants);

    this.tick(
      drivers,
      dtSim,
      restaurants,
      (driver, type) => {
        this._log('arrival', {
          driver: driver.name,
          type,
        });

        this._assignment?.handleDriverArrived?.(
          driver,
          type,
          Date.now() / 1000
        );
      }
    );
  }

  // ─────────────────────────────────────────────
  tick(drivers, dtSim, restaurants, onDriverArrived) {
    this._log('tick_start', {
      drivers: drivers.length,
      dtSim,
    });

    for (const driver of drivers) {
      this._tickDriver(driver, dtSim, restaurants, onDriverArrived);
    }
  }

  _tickDriver(driver, dtSim, restaurants, onDriverArrived) {
    const path = Array.isArray(driver.path) ? driver.path : [];

    // 🔥 SOLO mover si corresponde
    const movingStates = [
      'moving_to_pickup',
      'moving_to_delivery',
      'moving_free'
    ];

    if (!movingStates.includes(driver.status)) {
      return;
    }

    if (path.length === 0) return;

    let remaining = dtSim;

    while (remaining > 0 && driver.path_index < path.length - 1) {

      const from = path[driver.path_index];
      const to   = path[driver.path_index + 1];

      const speed_ms = ((driver.speed_kmh ?? 30) * 1000) / 3600;

      const dist = haversineMeters(from, to);
      const segDur = dist / speed_ms;

      const remainingSeg = segDur - driver.segment_elapsed;

      if (remaining < remainingSeg) {

        const fraction = (driver.segment_elapsed + remaining) / segDur;

        driver.pos = {
          lat: from.lat + (to.lat - from.lat) * fraction,
          lng: from.lng + (to.lng - from.lng) * fraction,
        };

        driver.segment_elapsed += remaining;
        remaining = 0;

      } else {

        remaining -= remainingSeg;

        driver.path_index++;
        driver.segment_elapsed = 0;
        driver.pos = { lat: to.lat, lng: to.lng };

        if (driver.path_index >= path.length - 1) {

          driver.path = [];
          driver.path_index = 0;

          onDriverArrived?.(
            driver,
            driver._arrival_type ?? 'at_free_dest'
          );

          break;
        }
      }
    }
  }
}
