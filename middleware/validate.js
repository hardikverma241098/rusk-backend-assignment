/**
 * middleware/validate.js
 */

function required(fields, body) {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || body[f] === "");
  return missing.length > 0
    ? { valid: false, message: `Missing required fields: ${missing.join(", ")}` }
    : { valid: true };
}

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validateSignup(body) {
  const check = required(["userId", "email", "name"], body);
  if (!check.valid) return check;
  if (!isValidEmail(body.email)) return { valid: false, message: "Invalid email format" };
  return { valid: true };
}

function validatePurchase(body) {
  const check = required(["userId", "planId", "amount", "email"], body);
  if (!check.valid) return check;
  if (typeof body.amount !== "number" || body.amount <= 0)
    return { valid: false, message: "amount must be a positive number" };
  if (!isValidEmail(body.email)) return { valid: false, message: "Invalid email format" };
  return { valid: true };
}

function validateWatchEvent(body) {
  return required(["userId", "contentId", "watchedSeconds", "sessionId"], body);
}

module.exports = { validateSignup, validatePurchase, validateWatchEvent };
