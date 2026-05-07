/**
 * events/consumers/analyticsConsumer.js
 *
 * Listens to: user.signed_up, purchase.completed, watch.heartbeat
 * Responsibility: analytics tracking only
 *
 * Analytics gets EVERY heartbeat event — not just the latest.
 * This is intentional: analytics needs engagement curves, drop-off points,
 * rewatch behavior. This consumer writes to a time-series/OLAP store
 * (Clickhouse, BigQuery) — not the operational DB.
 */

const { kafka } = require("../../config/kafka");
const topics = require("../topics");
const logger = require("../../utils/logger");

async function trackEvent(payload) {
  await new Promise((r) => setTimeout(r, 30));
  logger.info({ event: payload.event, userId: payload.userId }, "[analytics] event tracked");
}

async function start() {
  const consumer = kafka.consumer({ groupId: "analytics-service" });
  await consumer.connect();
  await consumer.subscribe({ topic: topics.USER_SIGNED_UP });
  await consumer.subscribe({ topic: topics.PURCHASE_COMPLETED });
  await consumer.subscribe({ topic: topics.WATCH_HEARTBEAT });

  await consumer.run({
    eachBatch: async ({ batch }) => {
      for (const message of batch.messages) {
        const value = message.value;
        if (batch.topic === topics.WATCH_HEARTBEAT) {
          await trackEvent({ event: "watch_heartbeat", ...value });
        } else if (batch.topic === topics.USER_SIGNED_UP) {
          await trackEvent({ event: "user_signup", userId: value.userId, timestamp: value.timestamp });
        } else if (batch.topic === topics.PURCHASE_COMPLETED) {
          await trackEvent({ event: "subscription_purchase", userId: value.userId, planId: value.planId });
        }
      }
    },
  });

  logger.info("[consumer:analytics] running");
}

module.exports = { start };
