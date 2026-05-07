/**
 * events/topics.js
 * Single source of truth for all Kafka topic names.
 */

module.exports = {
  USER_SIGNED_UP: "user.signed_up",
  PURCHASE_COMPLETED: "purchase.completed",
  WATCH_HEARTBEAT: "watch.heartbeat", // one message per heartbeat, partitioned by userId
};
