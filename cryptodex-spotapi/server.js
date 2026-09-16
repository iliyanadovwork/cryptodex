// import package
import express from "express";
import morgan from "morgan";
import cors from "cors";
import http from "http";
import passport from "passport";
import bodyParser from "body-parser";
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// import config
import config from "./config/index.js";
import dbConnection from "./config/dbConnection.js";
import { createSocketIO } from "./config/socketIO.js";
// Reports whether redis is persisting the balance ledger. See the note on
// ledgerDurability: the guarantee is redis's to keep, not this service's.
import { warnIfLedgerNotDurable } from "./controllers/redis.controller.js";
import "./config/cron.js";
import {
  startBinanceWebSockets,
  setDepthListener,
} from "./lib/binanceWebSocket.js";
import { publishOrderBook } from "./controllers/bookPublish.controller.js";
import { usersAuth } from "./config/passport.js";
import { fetchAllpairs } from "./controllers/spot.controller.js";
import { purgePaperBook } from "./controllers/paperBook.controller.js";
import { loadPairsToRedis } from "./controllers/loadPairs.js";
import { startFillCanary } from "./controllers/fillCanary.js";
import { healthCheck } from "./controllers/health.controller.js";
import { SpotPair } from "./models/index.js";
import "./grpc/server.js";

// import routes
//
// THE ADMIN ROUTER AND THE /v1 AGGREGATOR ROUTER ARE GONE, deliberately.
//
// `/api/admin` carried the 14 admin endpoints (pair CRUD, the spot order/trade
// reports, the trade-bot and volume-bot CRUD, the fee report). None of them is
// reachable from this product any more - nothing calls them - and the venue is
// a spot-only paper venue whose pairs are
// seeded by ops/reset-and-seed.mjs rather than created over HTTP.
//
// `POST /api/admin/add-bot-user` went with it. It was the one endpoint worth
// pausing over, because the liquidity bot it names (adminbot@bot.com) is what
// paperBook.controller.js reads out of redis `admin_liquidity/liquidation`
// before it will build a ladder, and without it spot cannot fill an order at
// all. It is NOT the reset path: ops/reset-and-seed.mjs seeds both the mongo
// user and the redis field directly, in the exact shape userapi's `botUser()`
// wrote them, and documents at length why it does not use the endpoint (it
// needs an admin JWT that cannot exist yet at bring-up, and its unvalidated
// `type` degrades `User.findOne({role: undefined})` into "overwrite an
// arbitrary account"). So the recovery path is intact and strictly safer.
//
// `/v1/spot` published ticker/summary/orderbook/recentTrade in the shape data
// aggregators ingest to list a venue. On a paper venue those figures are
// fabricated, and the format is the part that makes them read as real market
// data, so the endpoints are removed rather than left answering.
import spotAPI from "./routes/spot.route.js";
import dashboardAPI from "./routes/dashboard.route.js";

// A stray promise rejection (e.g. an async route handler whose promise Express
// never observes) must degrade that one request, not take the whole API down.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

const app = express();
app.use(morgan("dev"));
app.use(cors({ origin: "*" }));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// passport
app.use(passport.initialize());
usersAuth(passport);

app.use(express.static(__dirname + "/public"));
// One probe path has to work everywhere, so /api/health answers here as it does
// on userapi and walletapi - and now it MEANS the same thing on all three:
// process and dependencies, via controllers/health.controller.js.
//
// It used to be aliased to the FILL CANARY, which answers 503 whenever the
// venue cannot fill an order. That conflated readiness with tradability, and on
// a single-market venue the canary's "degraded" middle state cannot occur, so
// any depth breaker made this endpoint 503 and failed the deploy healthcheck.
// The canary is unchanged and still serves /api/spot/health, which is what an
// uptime monitor or alerting rule should watch. See lib/serviceHealth.js.
app.get("/api/health", healthCheck);
app.use("/api/spot", spotAPI);
app.use("/api/dashboard", dashboardAPI);

//App Use
app.use("/app/spot", spotAPI);
app.use("/app/dashboard", dashboardAPI);

app.get("/", (req, res) => {
  return res.send("Successfully Testing Thank You");
});
let server = http.createServer(app);

createSocketIO(server);

// DATABASE CONNECTION
dbConnection((done) => {
  if (done) {
    server = server.listen(config.PORT, function () {
      console.log(
        "\x1b[34m%s\x1b[0m",
        `server is running on port ${config.PORT}`
      );
      setTimeout(async () => {
        // Mongo is authoritative for the pair list: refresh the redis pair
        // cache and prune pairs that no longer exist before anything reads it.
        await loadPairsToRedis();
        fetchAllpairs();
        // A ladder left in redis by the previous process is orphaned liquidity
        // quoting dead prices; drop it before the matcher can reach it.
        try {
          const binancePairs = await SpotPair.find({
            botstatus: "binance",
          }).lean();
          for (const pair of binancePairs) {
            await purgePaperBook(pair._id.toString());
          }
        } catch (err) {
          console.log("Error purging paper book on boot:", err.message);
        }
      }, 1000);

      // Start Binance WebSocket streams for real-time updates
      setTimeout(() => {
        // The depth cache does not publish anything itself: every "orderBook"
        // payload is derived once, in bookPublish, from the same snapshot and
        // behind the same health gate as the tradable ladder. Wiring it here
        // (rather than importing it there) keeps that dependency one-way.
        setDepthListener(publishOrderBook);
        startBinanceWebSockets();
      }, 5000);

      // Read-only self-test that spot can still fill; it delays its own first
      // run past boot. Nothing else notices when live liquidity dies.
      startFillCanary();

      // The balance ledger is only a source of truth if redis is persisting it.
      // That is an operator setting, not a code one, so the service cannot fix
      // it - but it can refuse to pretend. Said once, at boot.
      warnIfLedgerNotDurable().catch(() => {});
    });
  }
});
