/**
 * events/consumers/notificationConsumer.js
 *
 * Listens to: user.signed_up, purchase.completed
 * Responsibility: push notifications only
 */

const { kafka } = require("../../config/kafka");
const topics = require("../topics");
const logger = require("../../utils/logger");

// Mock push provider
async function sendPush({ token, title, body }) {
  if (!token) return;
  await new Promise((r) => setTimeout(r, 40));
  logger.info({ token, title }, "[push] notification sent");
}

async function start() {
  const consumer = kafka.consumer({ groupId: "notification-service" });
  await consumer.connect();
  await consumer.subscribe({ topic: topics.USER_SIGNED_UP });
  await consumer.subscribe({ topic: topics.PURCHASE_COMPLETED });

  await consumer.run({
    eachMessage: async ({ topic, message: { value } }) => {
      if (topic === topics.USER_SIGNED_UP) {
        const { name, deviceToken } = value;
        await sendPush({
          token: deviceToken,
          title: "Welcome to Alright!",
          body: `Hi ${name}, start watching now.`,
        });
      }

      if (topic === topics.PURCHASE_COMPLETED) {
        const { planId, deviceToken } = value;
        await sendPush({
          token: deviceToken,
          title: "Purchase Successful!",
          body: `Your ${planId} plan is now active.`,
        });
      }
    },
  });

  logger.info("[consumer:notification] running");
}

module.exports = { start };
