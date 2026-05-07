/**
 * jobs/watchFlushJob.js
 *
 * Periodically scans Redis for watch progress entries and batch-upserts
 * them to the DB. This is what makes the Redis-as-hot-layer pattern work —
 * Redis absorbs all the high-frequency writes, the flush job handles
 * persistence at a much lower and controlled rate.
 *
 * FLUSH INTERVAL vs REDIS TTL:
 *   Flush interval must always be significantly less than Redis TTL.
 *   If TTL = 24h and flush = 5min, we're safe.
 *   If a user pauses for 3h, their Redis key is still alive, flush job
 *   will have persisted their progress multiple times by then.
 *
 * DB WRITE VOLUME REDUCTION:
 *   Without flush job: 33,333 DB writes/s (at 1M users)
 *   With flush job (5min interval): 1M records / 300s = ~3,333 writes/s
 *   Done as bulk upsert: effectively a handful of DB round-trips per flush
 *
 * WHAT GETS WRITTEN:
 *   Only the latest maxWatchedSeconds per (userId, contentId).
 *   All intermediate heartbeats are collapsed — we never needed them.
 */

const { redis } = require("../config/redis");
const watchRepo = require("../repositories/watchRepo");
const logger = require("../utils/logger");

const FLUSH_INTERVAL_MS = parseInt(process.env.WATCH_FLUSH_INTERVAL_MS || "300000", 10); // 5 mins

async function flush() {
  const keys = await redis.scan("watch:progress:*");
  if (keys.length === 0) return;

  logger.info({ count: keys.length }, "[watch-flush-job] starting flush");

  const records = [];
  for (const key of keys) {
    const raw = await redis.getdel(key); // atomic get + delete
    if (raw) {
      try {
        records.push(JSON.parse(raw));
      } catch {
        logger.warn({ key }, "[watch-flush-job] failed to parse Redis entry — skipping");
      }
    }
  }

  if (records.length === 0) return;

  try {
    await watchRepo.batchUpsertProgress(records);
    logger.info({ count: records.length }, "[watch-flush-job] flushed to DB");
  } catch (err) {
    logger.error({ err, count: records.length }, "[watch-flush-job] DB upsert failed — progress may be lost");
    // In production: write failed records back to Redis or a dead-letter store
  }
}

function start() {
  const timer = setInterval(flush, FLUSH_INTERVAL_MS);
  timer.unref();
  logger.info({ intervalMs: FLUSH_INTERVAL_MS }, "[watch-flush-job] started");
  return {
    flush,
    stop: () => clearInterval(timer),
  };
}

module.exports = { start };
