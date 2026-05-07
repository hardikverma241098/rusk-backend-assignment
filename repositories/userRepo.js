const users = new Map(); // mock "DB"

async function save({ userId, email, name }) {
  if (users.has(userId)) {
    const err = new Error("User already exists");
    err.code = "DUPLICATE_USER";
    throw err;
  }
  users.set(userId, { userId, email, name });
  return new Promise((resolve) => setTimeout(resolve, 10));
}

module.exports = { save };