//  import packages
import express from "express";

// import controllers
import * as healthCtrl from "../controllers/health.controller.js";

const router = express();

// Liveness / readiness. Unauthenticated on purpose: it is what a human or an
// uptime monitor reaches for when the service feels wrong, and requiring a
// token would make it useless for exactly the case it exists for (the service
// is up but auth, or the redis the auth strategy reads, is broken). It returns
// process and dependency state only - see controllers/health.controller.js and
// lib/serviceHealth.js.
router.route("/").get(healthCtrl.healthCheck);

export default router;
