/**
 * services/purchaseService.js
 *
 * Idempotency flow:
 *   1. Check Redis for idempotency key (SET NX with 24h TTL)
 *   2. If key already exists → return cached response (replay)
 *   3. If key is new → write to DB → publish Kafka event → cache response
 *
 * The Redis SETNX is atomic — safe across multiple service instances.
 * In-memory fallback (config/redis.js) is per-process only; use real
 * Redis before running more than one instance.
 */

const purchaseRepo = require("../repositories/purchaseRepo");
const producer = require("../events/producer");
const topics = require("../events/topics");
const { redis } = require("../config/redis");
const logger = require("../utils/logger");

const IDEMPOTENCY_TTL_SECONDS = 86400; // 24 hours

async function completePurchase({ userId, planId, amount, email, deviceToken, idempotencyKey }) {
  const redisKey = `idempotency:purchase:${idempotencyKey}`;

  // Check for existing record
  const existing = await redis.get(redisKey);
  if (existing) {
    logger.info({ idempotencyKey, userId }, "[purchaseService] idempotent replay — returning cached response");
    return { replayed: true, data: JSON.parse(existing) };
  }

  // Attempt atomic lock
  const acquired = await redis.set(
    redisKey,
    JSON.stringify({ status: true, message: "Purchase recorded" }),
    "NX",
    "EX",
    IDEMPOTENCY_TTL_SECONDS
  );

  if (!acquired) {
    // Another instance won the race — treat as replay
    const cached = await redis.get(redisKey);
    return { replayed: true, data: JSON.parse(cached) };
  }

  // We hold the lock — proceed with DB write
  await purchaseRepo.save({ userId, planId, amount });
  logger.info({ userId, planId, amount }, "[purchaseService] purchase saved to DB");

  await producer.publish(
    topics.PURCHASE_COMPLETED,
    { userId, planId, amount, email, deviceToken, timestamp: Date.now() },
    userId
  );

  return { replayed: false, data: { status: true, message: "Purchase recorded" } };
}

module.exports = { completePurchase };
