/**
 * config/kafka.js
 *
 * In-process mock that mirrors the kafkajs producer/consumer API exactly.
 *
 * To switch to a real Kafka broker, replace this file with:
 *
 *   const { Kafka } = require('kafkajs');
 *   const kafka = new Kafka({ clientId: 'streaming-platform', brokers: [process.env.KAFKA_BROKER] });
 *   module.exports = { kafka };
 *
 * Nothing else in the codebase needs to change.
 */

const EventEmitter = require("events");
const logger = require("../utils/logger");

const bus = new EventEmitter();
bus.setMaxListeners(50);

class MockProducer {
  async connect() {
    logger.info("[kafka:producer] connected (mock)");
  }

  async disconnect() {
    logger.info("[kafka:producer] disconnected");
  }

  async send({ topic, messages }) {
    for (const message of messages) {
      const parsed = JSON.parse(message.value);
      logger.debug({ topic, key: message.key }, "[kafka:producer] publishing message");
      // setImmediate ensures consumers run asynchronously — same as real Kafka
      setImmediate(() => bus.emit(topic, parsed));
    }
  }
}

class MockConsumer {
  constructor({ groupId }) {
    this.groupId = groupId;
    this.topics = [];
  }

  async connect() {
    logger.info({ groupId: this.groupId }, "[kafka:consumer] connected (mock)");
  }

  async disconnect() {
    logger.info({ groupId: this.groupId }, "[kafka:consumer] disconnected");
  }

  async subscribe({ topic, fromBeginning }) {
    this.topics.push(topic);
  }

  async run({ eachMessage, eachBatch }) {
    this.topics.forEach((topic) => {
      bus.on(topic, async (value) => {
        try {
          if (eachBatch) {
            // Wrap single message as a batch — real Kafka delivers actual batches
            await eachBatch({
              batch: { topic, messages: [{ value, offset: "0" }] },
            });
          } else {
            await eachMessage({ topic, partition: 0, message: { value } });
          }
        } catch (err) {
          logger.error({ topic, groupId: this.groupId, err }, "[kafka:consumer] message handler failed");
        }
      });
    });
  }
}

class MockKafka {
  producer() {
    return new MockProducer();
  }

  consumer(opts) {
    return new MockConsumer(opts);
  }
}

module.exports = { kafka: new MockKafka() };
