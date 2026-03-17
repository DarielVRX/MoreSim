import { haversineMeters } from './GraphCache.js';

export class EtaEstimator {
  constructor({ assignmentUtils, gridSizeMeters = 75, timeBucketSeconds = 60, cacheMaxEntries = 3000 }) {
    this._utils = assignmentUtils;
    this._gridSizeMeters = gridSizeMeters;
    this._timeBucketSeconds = timeBucketSeconds;
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
    return `${this._quantize(pos.lat)}:${this._quantize(pos.lng)}`;
  }

  _buildCacheKey(fromPos, toPos, driver, simTime = 0) {
    const speed = this._utils.getSpeedMs(driver);
    const timeBucket = Math.floor(Math.max(0, simTime) / this._timeBucketSeconds);
    return `${this._key(fromPos)}->${this._key(toPos)}@${speed.toFixed(2)}#${timeBucket}`;
  }

  _setCache(key, value) {
    if (this._cache.size >= this._cacheMaxEntries) {
      const oldest = this._cache.keys().next().value;
      this._cache.delete(oldest);
    }
    this._cache.set(key, value);
  }

  estimate(fromPos, toPos, driver, simTime = 0) {
    const key = this._buildCacheKey(fromPos, toPos, driver, simTime);
    if (this._cache.has(key)) return this._cache.get(key);

    const speedMs = this._utils.getSpeedMs(driver);
    const eta = haversineMeters(fromPos, toPos) / speedMs;
    this._setCache(key, eta);
    return eta;
  }
}

