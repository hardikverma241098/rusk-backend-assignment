/**
 * services/userService.js
 * Orchestrates user signup — DB write then Kafka event.
 */

const userRepo = require("../repositories/userRepo");
const producer = require("../events/producer");
const topics = require("../events/topics");
const logger = require("../utils/logger");

async function signup({ userId, email, name, deviceToken }) {
  await userRepo.save({ userId, email, name });
  logger.info({ userId }, "[userService] user saved to DB");

  await producer.publish(
    topics.USER_SIGNED_UP,
    { userId, email, name, deviceToken, timestamp: Date.now() },
    userId
  );
}

module.exports = { signup };
