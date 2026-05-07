/**
 * events/consumers/crmConsumer.js
 *
 * Listens to: user.signed_up, purchase.completed
 * Responsibility: CRM contact sync and campaign triggers
 */

const { kafka } = require("../../config/kafka");
const topics = require("../topics");
const logger = require("../../utils/logger");

async function syncContact({ email, name, source }) {
  await new Promise((r) => setTimeout(r, 50));
  logger.info({ email, source }, "[crm] contact synced");
}

async function triggerCampaign({ userId, campaignId }) {
  await new Promise((r) => setTimeout(r, 40));
  logger.info({ userId, campaignId }, "[crm] campaign triggered");
}

async function start() {
  const consumer = kafka.consumer({ groupId: "crm-service" });
  await consumer.connect();
  await consumer.subscribe({ topic: topics.USER_SIGNED_UP });
  await consumer.subscribe({ topic: topics.PURCHASE_COMPLETED });

  await consumer.run({
    eachMessage: async ({ topic, message: { value } }) => {
      if (topic === topics.USER_SIGNED_UP) {
        await syncContact({ email: value.email, name: value.name, source: "organic_signup" });
      }

      if (topic === topics.PURCHASE_COMPLETED) {
        await triggerCampaign({ userId: value.userId, campaignId: "post_purchase_upsell" });
      }
    },
  });

  logger.info("[consumer:crm] running");
}

module.exports = { start };
