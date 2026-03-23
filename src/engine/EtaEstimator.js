import { haversineMeters } from './GraphCache.js';

export class EtaEstimator {
  constructor({ assignmentUtils, gridSizeMeters = 75, cacheMaxEntries = 3000 }) {
    this._utils = assignmentUtils;
    this._gridSizeMeters = gridSizeMeters;
    this._cacheMaxEntries = cacheMaxEntries;
    this._cache = new Map();
  }

  update({ assignmentUtils }) {
    if (assignmentUtils) this._utils = assignmentUtils;
  }

  _quantize(value) {
    return Math.round(value / this._gridSizeMeters) * this._gridSizeMeters;
  }

  _key(pos) {
    const latMeters = pos.lat * 111320;
    const lngMeters = pos.lng * 111320 * Math.cos(pos.lat * Math.PI / 180);

    const qLat = Math.round(latMeters / this._gridSizeMeters);
    const qLng = Math.round(lngMeters / this._gridSizeMeters);

    return `${qLat}:${qLng}`;
  }

  _buildCacheKey(fromPos, toPos, driver) {
    const speed = this._utils.getSpeedMs(driver);
    return `${this._key(fromPos)}->${this._key(toPos)}@${speed.toFixed(2)}`;
  }

  _setCache(key, value) {
    if (this._cache.size >= this._cacheMaxEntries) {
      const oldest = this._cache.keys().next().value;
      this._cache.delete(oldest);
    }
    this._cache.set(key, value);
  }

  estimate(fromPos, toPos, driver) {
    const key = this._buildCacheKey(fromPos, toPos, driver);
    if (this._cache.has(key)) return this._cache.get(key);

    const speedMs = this._utils.getSpeedMs(driver);
    const eta = haversineMeters(fromPos, toPos) / speedMs;
    this._setCache(key, eta);
    return eta;
  }
}
