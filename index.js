const express = require("express");
const { v4: uuidv4 } = require("uuid");
const routes = require("./routes");
const errorHandler = require("./middleware/errorHandler");
const producer = require("./events/producer");
const consumers = require("./events/consumers");
const watchFlushJob = require("./jobs/watchFlushJob");
const logger = require("./utils/logger");

const app = express();
app.use(express.json());

// Attach requestId to every request for end-to-end tracing
app.use((req, res, next) => {
  req.requestId = req.headers["x-request-id"] || uuidv4();
  res.setHeader("x-request-id", req.requestId);
  next();
});

app.use(routes);

app.use((req, res) => {
  res.status(404).json({ status: false, message: "Route not found" });
});

app.use(errorHandler);

async function start() {
  await producer.connect();
  await consumers.startAll();

  // Start periodic watch progress flush: Redis → DB
  const flushJob = watchFlushJob.start();

  const PORT = process.env.PORT || 3000;
  const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, "Server running");
  });

  async function shutdown(signal) {
    logger.info({ signal }, "Shutting down gracefully");
    server.close(async () => {
      // Final flush before exit — don't lose buffered progress on deploy
      await flushJob.flush();
      flushJob.stop();
      await producer.disconnect();
      logger.info("Shutdown complete");
      process.exit(0);
    });
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch((err) => {
  logger.error({ err }, "Failed to start server");
  process.exit(1);
});
