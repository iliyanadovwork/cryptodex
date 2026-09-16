// import package
import cron from 'node-cron'

// import config
import config from '../config/index.js'


/**
 * Every 5 Second
 */
export const binOrderTask = cron.schedule(
  "*/5 * * * * *",
  () => {
    require("../controllers/binance.controller").checkOrder();
  },
  {
    scheduled: false,
  }
);


export const warazix_get_allOrder = cron.schedule(
  "*/5 * * * * *",
  (date) => {
    // console.log(
    //   "-----warazix_get_allOrder warazix_get_allOrder warazix_get_allOrder"
    // );
  },
  {
    scheduled: false,
  }
);

export const warazixApi = cron.schedule("*/10 * * * *", (date) => {
  // console.log("cronwarazixApiwarazixApiwarazixApiwarazixApi */20 * * * *");
});

// Temporarily disabled due to errors
// export const depthSocket = cron.schedule("*/10 * * * * *", (date) => {
//   require("../controllers/spot.controller").depthData();
// });

cron.schedule("* * * * *", (date) => {
  require("../controllers/chart/chart.controller").redisToDB('1m');
});

cron.schedule("*/5 * * * *", (date) => {
  require("../controllers/chart/chart.controller").redisToDB('5m');
});

cron.schedule("*/15 * * * *", (date) => {
  require("../controllers/chart/chart.controller").redisToDB('15m');
});

cron.schedule("*/30 * * * *", (date) => {
  require("../controllers/chart/chart.controller").redisToDB('30m');
});

cron.schedule("0 * * * *", (date) => {
  require("../controllers/chart/chart.controller").redisToDB('1h');
});

cron.schedule("0 */4 * * *", (date) => {
  require("../controllers/chart/chart.controller").redisToDB('4h');
});

cron.schedule("0 0 * * *", (date) => {
  require("../controllers/chart/chart.controller").redisToDB('1d');
});

cron.schedule("0 0 * * 0", (date) => {
  require("../controllers/chart/chart.controller").redisToDB('1W');
});

cron.schedule("0 0 1 * *", (date) => {
  require("../controllers/chart/chart.controller").redisToDB('1M');
});



// THE TRADE-BOT AND VOLUME-BOT TICKS ARE GONE with their controllers.
//
// Both were driven off mongo collections (`tradeBot`, `volumeBot`) that only
// the admin endpoints could ever populate, and both collections are empty on
// this venue - so the ticks were already no-ops, waking twice a minute to run
// a `find()` that returned nothing. With `/api/admin` removed there is no
// longer any way to create a row for them to act on, so they could never
// become anything else.
//
// This does NOT touch the liquidity the venue actually trades against: the
// paper ladder is built by controllers/paperBook.controller.js off redis
// `admin_liquidity/liquidation`, on a completely separate path.
cron.schedule("0 12 * * 0", () => { //every sunday 12 pm
  require('../controllers/spot.controller').clearSpotRedis();
});

// Cache the controller module to avoid repeated dynamic imports
let binanceController = null;

// Update Binance prices every 30 seconds for active trading pairs
// (WebSocket streams provide real-time updates, this is a backup)
cron.schedule("*/30 * * * * *", async () => {
  try {
    console.log('[Cron] Running updateBinancePrices...');
    if (!binanceController) {
      binanceController = await import('../controllers/binance.controller.js');
    }
    await binanceController.updateBinancePrices();
  } catch (err) {
    console.log('[Cron] updateBinancePrices error:', err.message);
  }
});

// NOTE: Orderbook depth updates are handled by the Binance WebSocket streams in
// lib/binanceWebSocket.js, which own the redis depth mirror, and published by
// controllers/bookPublish.controller.js, which owns every "orderBook" emit.
// The disabled 3s poller that used to live here (binance.updateOrderbookDepth)
// has been deleted rather than left commented out: it emitted an ungated book
// of its own, so un-commenting it would have quietly reintroduced a second,
// unhealth-gated derivation of the display.

// Update chart candlestick data from Binance every minute for active pairs
cron.schedule("0 * * * * *", async () => {
  try {
    console.log('[Cron] Running updateChartData...');
    if (!binanceController) {
      binanceController = await import('../controllers/binance.controller.js');
    }
    await binanceController.updateChartData();
  } catch (err) {
    console.log('[Cron] updateChartData error:', err.message);
  }
});
