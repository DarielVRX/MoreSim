// src/engine/SimClock.js
//
// Reloj de simulación en tiempo real con multiplicador 1-60x.
// Llama a tick(dtSim) en cada frame, donde dtSim = tiempo simulado en segundos.
// Usa requestAnimationFrame para precisión y no consumir CPU cuando la tab está oculta.

export class SimClock {
  constructor() {
    this._multiplier  = 1;
    this._running     = false;
    this._lastRealMs  = null;
    this._rafId       = null;
    this._onTick      = null;   // callback(dtSim: number, simTime: number)
    this._simTime     = 0;      // segundos simulados totales desde que inició
    this._startWallMs = null;
  }

  get simTime()     { return this._simTime; }
  get multiplier()  { return this._multiplier; }
  get running()     { return this._running; }

  setMultiplier(x) {
    this._multiplier = Math.max(1, Math.min(60, Math.round(x)));
  }

  setOnTick(fn) { this._onTick = fn; }

  start() {
    if (this._running) return;
    this._running    = true;
    this._lastRealMs = performance.now();
    if (!this._startWallMs) this._startWallMs = Date.now();
    this._loop();
  }

  pause() {
    this._running    = false;
    this._lastRealMs = null;
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
  }

  reset() {
    this.pause();
    this._simTime     = 0;
    this._startWallMs = null;
  }

  // Avanzar manualmente un número de segundos simulados (útil para tests)
  advanceBy(dtSim) {
    this._simTime += dtSim;
    this._onTick?.(dtSim, this._simTime);
  }

  _loop() {
    if (!this._running) return;
    this._rafId = requestAnimationFrame((nowMs) => {
      if (!this._running) return;
      const realDt   = (nowMs - (this._lastRealMs ?? nowMs)) / 1000; // segundos reales
      this._lastRealMs = nowMs;
      // Cap: máximo 200ms reales por frame para evitar saltos grandes si la tab
      // estuvo en segundo plano
      const dtSim = Math.min(realDt, 0.2) * this._multiplier;
      this._simTime += dtSim;
      this._onTick?.(dtSim, this._simTime);
      this._loop();
    });
  }

  // Formato legible mm:ss para el HUD
  formatSimTime() {
    const total = Math.floor(this._simTime);
    const m     = Math.floor(total / 60).toString().padStart(2, '0');
    const s     = (total % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }
}
