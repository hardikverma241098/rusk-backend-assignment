/**
 * events/consumers/watchConsumer.js
 *
 * Listens to: watch.heartbeat
 * Responsibility: update Redis with latest watch progress per (userId, contentId)
 *
 * WHY REDIS AND NOT DIRECT DB WRITE:
 * At 1M concurrent users, heartbeats arrive at ~33,333/s.
 * Writing every heartbeat to the DB would mean 33,333 individual writes/s.
 * But we don't need every heartbeat — we only need the LATEST watchedSeconds
 * per (userId, contentId). Redis is the hot write layer:
 *   - Consumer does an atomic SETMAX in Redis on every message
 *   - A separate flush job (jobs/watchFlushJob.js) periodically batch-upserts
 *     Redis state → DB, reducing DB load by 10-100x
 *
 * MULTI-DEVICE CONSISTENCY:
 * Two devices watching the same content write to the same Redis key.
 * The SETMAX operation ensures we always keep the furthest point reached,
 * regardless of which device sent the last heartbeat.
 * Example: mobile at 30min, laptop rewatching from 0min →
 *   mobile heartbeat: SETMAX keeps 30min ✅
 *   laptop heartbeat: SETMAX keeps 30min (30 > 10) ✅
 *
 * OUT-OF-ORDER MESSAGES:
 * Partitioned by userId → all messages for a user on one partition → ordered.
 * SETMAX in Redis also protects against any edge-case reordering.
 *
 * VIDEO COMPLETION:
 * If watchedSeconds >= 95% of content duration, mark as completed in Redis.
 * Client should send content duration in the heartbeat payload.
 * On completion, resume position resets to 0 (watch from beginning next time).
 */

const { kafka } = require("../../config/kafka");
const { redis } = require("../../config/redis");
const topics = require("../topics");
const logger = require("../../utils/logger");

const REDIS_TTL_SECONDS = 86400;          // 24 hours — must be > flush job interval
const COMPLETION_THRESHOLD = 0.95;        // 95% watched = completed

async function start() {
  const consumer = kafka.consumer({ groupId: "watch-progress-writer" });
  await consumer.connect();
  await consumer.subscribe({ topic: topics.WATCH_HEARTBEAT });

  await consumer.run({
    eachBatch: async ({ batch }) => {
      for (const message of batch.messages) {
        const event = message.value;
        const { userId, contentId, watchedSeconds, sessionId, deviceType, contentDuration, timestamp } = event;

        const redisKey = `watch:progress:${userId}:${contentId}`;

        // Atomic SETMAX — only updates if new value is greater
        // Protects against: out-of-order delivery, multi-device race conditions
        await redis.setmax(
          redisKey,
          watchedSeconds,
          { userId, contentId, maxWatchedSeconds: watchedSeconds, sessionId, deviceType, updatedAt: timestamp },
          REDIS_TTL_SECONDS
        );

        // Completion detection
        if (contentDuration && watchedSeconds >= contentDuration * COMPLETION_THRESHOLD) {
          await redis.set(
            `watch:completed:${userId}:${contentId}`,
            JSON.stringify({ userId, contentId, completedAt: timestamp }),
            "EX",
            86400 * 30  // 30 day retention for completion state
          );
          logger.info({ userId, contentId }, "[consumer:watch] content marked as completed");
        }
      }

      logger.debug({ count: batch.messages.length }, "[consumer:watch] batch processed");
    },
  });

  logger.info("[consumer:watch] running");
}

module.exports = { start };
