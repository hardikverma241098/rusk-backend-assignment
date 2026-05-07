/**
 * events/consumers/revenueConsumer.js
 *
 * Listens to: purchase.completed
 * Responsibility: revenue capture + purchase confirmation email
 */

const { kafka } = require("../../config/kafka");
const topics = require("../topics");
const logger = require("../../utils/logger");

async function captureRevenue({ userId, amount, currency }) {
  await new Promise((r) => setTimeout(r, 40));
  logger.info({ userId, amount, currency }, "[revenue] captured");
}

async function sendEmail({ to, subject, template, data }) {
  await new Promise((r) => setTimeout(r, 40));
  logger.info({ to, template }, "[email] sent");
}

async function start() {
  const consumer = kafka.consumer({ groupId: "revenue-service" });
  await consumer.connect();
  await consumer.subscribe({ topic: topics.PURCHASE_COMPLETED });

  await consumer.run({
    eachMessage: async ({ topic, message: { value } }) => {
      const { userId, amount, email, planId } = value;

      await Promise.allSettled([
        captureRevenue({ userId, amount, currency: "INR" }),
        sendEmail({
          to: email,
          subject: "Your subscription is active",
          template: "purchase_confirmation",
          data: { planId, amount },
        }),
      ]);
    },
  });

  logger.info("[consumer:revenue] running");
}

module.exports = { start };
