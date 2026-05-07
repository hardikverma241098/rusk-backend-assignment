const logger = require("../utils/logger");

function errorHandler(err, req, res, next) {
  logger.error({ err, requestId: req.requestId, path: req.path }, "[error-handler] unhandled error");
  res.status(500).json({ status: false, message: "Internal server error" });
}

module.exports = errorHandler;
