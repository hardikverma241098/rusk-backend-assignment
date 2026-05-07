const { validatePurchase } = require("../middleware/validate");
const purchaseService = require("../services/purchaseService");
const logger = require("../utils/logger");

exports.handleContentPurchase = async (req, res, next) => {
  const { userId, planId, amount, email, deviceToken } = req.body;
  const idempotencyKey = req.headers["idempotency-key"] || `${userId}:${planId}`;

  const validation = validatePurchase(req.body);
  if (!validation.valid) {
    return res.status(400).json({ status: false, message: validation.message });
  }

  try {
    const result = await purchaseService.completePurchase({
      userId, planId, amount, email, deviceToken, idempotencyKey,
    });

    if (result.replayed) {
      logger.info({ userId, idempotencyKey, requestId: req.requestId }, "[handler:purchase] idempotent replay");
    }

    res.status(200).json(result.data);
  } catch (err) {
    next(err);
  }
};
