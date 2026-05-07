// repositories/purchaseRepo.js
async function save({ userId, planId, amount }) {
  return new Promise((resolve) => setTimeout(resolve, 15));
}
module.exports = { save };
