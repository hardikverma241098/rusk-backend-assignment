/**
 * config/redis.js
 *
 * In-process mock mirroring the ioredis API for the operations we use.
 *
 * To switch to real Redis:
 *   const Redis = require('ioredis');
 *   const redis = new Redis({ host: process.env.REDIS_HOST, port: 6379 });
 *   module.exports = { redis };
 *
 * Note: This store is per-process. Real Redis is mandatory before
 * running more than one service instance.
 */

const logger = require("../utils/logger");

class MockRedis {
  constructor() {
    this.store = new Map();
  }

  // SET key value [NX] [EX seconds]
  async set(key, value, ...args) {
    const options = {};
    for (let i = 0; i < args.length; i++) {
      if (typeof args[i] === "string" && args[i].toUpperCase() === "NX") options.nx = true;
      if (typeof args[i] === "string" && args[i].toUpperCase() === "EX") options.ex = args[++i];
    }

    if (options.nx && this.store.has(key)) {
      const entry = this.store.get(key);
      if (!entry.expiresAt || Date.now() < entry.expiresAt) return null;
    }

    this.store.set(key, {
      value,
      expiresAt: options.ex ? Date.now() + options.ex * 1000 : null,
    });

    logger.debug({ key }, "[redis:mock] SET");
    return "OK";
  }

  async get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  /**
   * Atomic compare-and-set: only update if new maxWatchedSeconds is greater.
   * Equivalent to a Redis Lua script in production:
   *
   *   local cur = redis.call('GET', KEYS[1])
   *   if not cur or cjson.decode(cur).maxWatchedSeconds < tonumber(ARGV[1]) then
   *     redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
   *     return 1
   *   end
   *   redis.call('EXPIRE', KEYS[1], ARGV[3])  -- always refresh TTL
   *   return 0
   */
  async setmax(key, newWatchedSeconds, payload, ttlSeconds) {
    const entry = this.store.get(key);
    const expiresAt = Date.now() + ttlSeconds * 1000;

    if (!entry || (entry.expiresAt && Date.now() > entry.expiresAt)) {
      this.store.set(key, { value: JSON.stringify(payload), expiresAt });
      return "SET";
    }

    const existing = JSON.parse(entry.value);
    if (newWatchedSeconds > existing.maxWatchedSeconds) {
      this.store.set(key, { value: JSON.stringify(payload), expiresAt });
      return "UPDATED";
    }

    // Value unchanged but always refresh TTL on activity
    entry.expiresAt = expiresAt;
    return "UNCHANGED";
  }

  // Scan keys matching prefix pattern (mock: prefix* only)
  async scan(pattern) {
    const prefix = pattern.replace("*", "");
    const keys = [];
    for (const [key, entry] of this.store.entries()) {
      if (key.startsWith(prefix) && (!entry.expiresAt || Date.now() < entry.expiresAt)) {
        keys.push(key);
      }
    }
    return keys;
  }

  // Atomically get value and remove key
  async getdel(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    this.store.delete(key);
    return entry.value;
  }
}

module.exports = { redis: new MockRedis() };
