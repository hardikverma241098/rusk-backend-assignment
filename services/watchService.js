/**
 * services/watchService.js
 *
 * The watch service is now a thin publish layer.
 * No in-memory buffer — each heartbeat goes directly to Kafka.
 *
 * At 1M concurrent users (~33,333 req/s), Kafka handles this comfortably.
 * Batching happens downstream: the watch consumer uses eachBatch to
 * process messages in bulk and writes to Redis atomically.
 *
 * Partitioned by userId so all heartbeats for a user land on the
 * same partition — guaranteeing ordering per user.
 */

const producer = require("../events/producer");
const topics = require("../events/topics");

async function recordHeartbeat({ userId, contentId, watchedSeconds, sessionId, deviceType }) {
  await producer.publish(
    topics.WATCH_HEARTBEAT,
    { userId, contentId, watchedSeconds, sessionId, deviceType, timestamp: Date.now() },
    userId // partition key — ordering per user
  );
}

module.exports = { recordHeartbeat };
