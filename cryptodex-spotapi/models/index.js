// import model
//
// NAMES MATCH COLLECTIONS HERE. They did not always, and it was a trap:
//
//   was `SpotTrade`         -> ./spotTrade.js   -> collection `spotOrder`
//   was `SpotOrder`         -> ./orderHistory.js -> collection `orderHistory`
//   was `spotOrderHistory`  -> ./orderHistory.js -> the SAME model again
//
// So `SpotOrder` meant the order-HISTORY table while the live/open order table
// answered to `SpotTrade`, and one model was exported under two names. Reading
// any consumer required remembering the inversion; getting it wrong is a
// wrong-collection bug that no type checker here would catch.
//
// Now: `SpotOrder` IS collection `spotOrder`, `OrderHistory` IS collection
// `orderHistory`, and the duplicate alias is gone. tests/unit/model-registry.test.js
// pins each export to its collection so this cannot drift back.
import SpotPair from './spotpair.js'
import SpotOrder from './spotTrade.js'
import OrderHistory from './orderHistory.js'
import FavPair from "./favouritepair.js";
import TradeHistory from "./tradeHistory.js"
import ChartSchema from "./chartdoc.js"
import TradeBot from "./tradeBot.js"
import VolumeBot from "./volumeBot.js"
import SequenceId from "./sequenceId.js"
import DepositEvent from "./depositEvent.js"
import WithdrawalEvent from "./withdrawalEvent.js"

export {
  SpotPair,
  SpotOrder,
  OrderHistory,
  FavPair,
  TradeHistory,
  TradeBot,
  ChartSchema,
  VolumeBot,
  SequenceId,
  DepositEvent,
  WithdrawalEvent,
};
