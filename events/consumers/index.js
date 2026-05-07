const notificationConsumer = require("./notificationConsumer");
const analyticsConsumer = require("./analyticsConsumer");
const crmConsumer = require("./crmConsumer");
const revenueConsumer = require("./revenueConsumer");
const watchConsumer = require("./watchConsumer");
const logger = require("../../utils/logger");

async function startAll() {
  await Promise.all([
    notificationConsumer.start(),
    analyticsConsumer.start(),
    crmConsumer.start(),
    revenueConsumer.start(),
    watchConsumer.start(),
  ]);
  logger.info("[consumers] all consumers running");
}

module.exports = { startAll };
