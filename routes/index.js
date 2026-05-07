const { Router } = require("express");
const { handleUserSignup } = require("../handlers/user");
const { handleContentPurchase } = require("../handlers/purchase");
const { handleVideoWatched } = require("../handlers/watch");

const router = Router();

router.post("/user/signup", handleUserSignup);
router.post("/purchase/complete", handleContentPurchase);
router.post("/watch/event", handleVideoWatched);

module.exports = router;
