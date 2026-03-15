// src/replay/Recorder.js
//
// Guarda snapshots del WorldState cada SNAPSHOT_INTERVAL segundos simulados.
// Los snapshots son deep-clones ligeros (sin path completo de drivers).
// El Replayer usa estos snapshots para el scrubber de replay.

const SNAPSHOT_INTERVAL = 15; // segundos simulados entre snapshots

export class Recorder {
  constructor() {
    this._snapshots     = [];   // [{ simTime, world }]
    this._lastSnapshot  = 0;
    this._recording     = false;
    this._events        = [];   // log de eventos completo
  }

  get snapshots() { return this._snapshots; }
  get events()    { return this._events; }

  start() {
    this._recording  = true;
    this._snapshots  = [];
    this._events     = [];
    this._lastSnapshot = 0;
  }

  stop() { this._recording = false; }

  reset() {
    this.stop();
    this._snapshots = [];
    this._events    = [];
    this._lastSnapshot = 0;
  }

  addEvent(event) {
    if (this._recording) this._events.push({ ...event });
  }

  // Llamado en cada tick — decide si hay que guardar snapshot
  maybeSave(simTime, world) {
    if (!this._recording) return;
    if (simTime - this._lastSnapshot < SNAPSHOT_INTERVAL) return;
    this._lastSnapshot = simTime;
    this._snapshots.push({
      simTime,
      world: deepCloneWorld(world),
    });
  }

  // Retorna el snapshot más cercano a un tiempo dado
  getSnapshotAt(targetTime) {
    if (this._snapshots.length === 0) return null;
    let best = this._snapshots[0];
    for (const snap of this._snapshots) {
      if (Math.abs(snap.simTime - targetTime) < Math.abs(best.simTime - targetTime)) {
        best = snap;
      }
    }
    return best;
  }

  // Retorna eventos ocurridos entre t0 y t1
  getEventsBetween(t0, t1) {
    return this._events.filter(e => e.time >= t0 && e.time <= t1);
  }
}

// Deep clone mínimo del world — omite paths largos para ahorrar memoria
function deepCloneWorld(world) {
  return {
    params:      { ...world.params },
    drivers:     Object.fromEntries(
      Object.entries(world.drivers).map(([id, d]) => [id, cloneDriver(d)])
    ),
    restaurants: Object.fromEntries(
      Object.entries(world.restaurants).map(([id, r]) => [id, { ...r, orders_config: [...(r.orders_config ?? [])] }])
    ),
    customers:   Object.fromEntries(
      Object.entries(world.customers).map(([id, c]) => [id, { ...c }])
    ),
    orders:      Object.fromEntries(
      Object.entries(world.orders).map(([id, o]) => [id, { ...o }])
    ),
  };
}

function cloneDriver(d) {
  return {
    ...d,
    orders:  [...d.orders],
    metrics: { ...d.metrics },
    // Omitir path (puede ser muy largo) — en replay solo se muestra posición
    path:    [],
    pos:     { ...d.pos },
  };
}
