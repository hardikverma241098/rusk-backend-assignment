/**
 * events/producer.js
 *
 * Singleton Kafka producer. Call connect() once at startup,
 * then use publish() throughout the app.
 */

const { kafka } = require("../config/kafka");
const logger = require("../utils/logger");

const producer = kafka.producer();

async function connect() {
  await producer.connect();
}

async function publish(topic, payload, key = null) {
  await producer.send({
    topic,
    messages: [
      {
        key: key ? String(key) : null,
        value: JSON.stringify(payload),
      },
    ],
  });
  logger.info({ topic, key }, "[producer] event published");
}

async function disconnect() {
  await producer.disconnect();
}

module.exports = { connect, publish, disconnect };
