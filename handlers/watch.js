const { validateWatchEvent } = require("../middleware/validate");
const { recordHeartbeat } = require("../services/watchService");
const logger = require("../utils/logger");

exports.handleVideoWatched = async (req, res, next) => {
  const { userId, contentId, watchedSeconds, sessionId, deviceType } = req.body;

  const validation = validateWatchEvent(req.body);
  if (!validation.valid) {
    return res.status(400).json({ status: false, message: validation.message });
  }

  try {
    await recordHeartbeat({ userId, contentId, watchedSeconds, sessionId, deviceType });
    logger.debug({ userId, contentId, requestId: req.requestId }, "[handler:watch] heartbeat published");
    res.status(200).json({ status: true });
  } catch (err) {
    next(err);
  }
};
