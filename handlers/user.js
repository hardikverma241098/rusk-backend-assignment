const { validateSignup } = require("../middleware/validate");
const userService = require("../services/userService");
const logger = require("../utils/logger");

exports.handleUserSignup = async (req, res, next) => {
  const { userId, email, name, deviceToken } = req.body;

  const validation = validateSignup(req.body);
  if (!validation.valid) {
    return res.status(400).json({ status: false, message: validation.message });
  }

  try {
    await userService.signup(req.body);
    logger.info({ userId: req.body.userId, requestId: req.requestId }, "[handler:user] signup complete");
    res.status(201).json({ status: true, message: "User created successfully" });
  } catch (err) {
    if (err.code === "DUPLICATE_USER") {
      return res.status(409).json({ status: false, message: "User already exists" });
    }
    next(err);
  }
};
