// import package
import mongoose from "mongoose";
import lodash from "lodash";
import axios from "axios";

// import config
import config from "../config/index.js";
import { binanceApiNode, nodeBinanceAPI } from "../config/binance.js";
import { socketEmitAll, socketEmitOne } from "../config/socketIO.js";
import { binOrderTask } from "../config/cron.js";
import { passbook } from "../grpc/walletService.js";
// import controller
import {
  newOrderHistory,
  FetchpairData,
  newTradeHistory,
  getOpenOrderSocket,
  getOrderHistorySocket,
  setDepthBinanceHist,
} from "./spot.controller.js";
// The ONE publisher of an "orderBook" payload. Nothing in this file may emit
// that event itself - see the partialDepth callback below.
import { publishOrderBook } from "./bookPublish.controller.js";

// import model
import { SpotPair, SpotOrder, OrderHistory } from "../models/index.js";

// import lib
import isEmpty from "../lib/isEmpty.js";
// The 24h header statistics - what they mean, the identities that make them a
// coherent set rather than four unrelated numbers, and the one place the cache,
// the pair document and the socket payload are all built from.
import { buildPairPayloads } from "../lib/ticker24h.js";
import { replacePair } from "../lib/pairHelper.js";
import {
  hset,
  hget,
  hgetall,
  hincby,
  hincbyfloat,
  hdel,
  hdetall,
  moveBalanceSigned,
  set,
} from "../controllers/redis.controller.js";
import { toFixed, toFixedDown, truncateDecimals } from "../lib/roundOf.js";

// REMOVED, both lines. They mutated the GLOBAL axios singleton at import time,
// and this module is on the boot import chain (spot.controller.js imports it),
// so the effect was process-wide and permanent:
//
//   axios.defaults.baseURL = config.BINANCE_GATE_WAY.API_URL;
//   axios.defaults.headers.common["X-MBX-APIKEY"] = config.BINANCE_GATE_WAY.API_KEY;
//
// 1. `BINANCE_GATE_WAY.API_URL` is commented out in config/index.js, so the
//    first line set baseURL to `undefined` for every axios caller in spotapi.
// 2. The second attached the Binance API key to EVERY outbound axios request
//    the service made, including ones to hosts that are not Binance.
//
// Neither was needed. Every axios call site in this service passes an absolute
// URL (verified: controllers/*, lib/binanceWebSocket.js), and every live one
// targets a PUBLIC Binance endpoint - /api/v3/depth, /ticker/24hr, /klines,
// /aggTrades - which takes no credential. The authenticated Binance surface
// goes through the node-binance-api SDK in config/binance.js, which carries its
// own key and never consulted these defaults.
const ObjectId = mongoose.Types.ObjectId;
let partialDepth, markDepth, RecentDepth;
export const spotOrderBookWS = async () => {
  try {
    if (partialDepth) {
      partialDepth();
    }
    let getSpotPair = await SpotPair.aggregate([
      {
        $match: { botstatus: { $in: ["off", "binance"] } }
      },
      {
        $project: {
          _id: 1,
          symbol: {
            $concat: [
              "$firstCurrencySymbol",
              {
                $switch: {
                  branches: [
                    {
                      case: { $eq: ["$secondCurrencySymbol", "USD"] },
                      then: "USDT",
                    },
                  ],
                  default: "$secondCurrencySymbol",
                },
              },
            ],
          },
          level: { $literal: 20 },
          markupPercentage: 1,
        },
      },
    ]);
    // console.log(getSpotPair, "------77");

    if (getSpotPair && getSpotPair.length > 0) {
      partialDepth = binanceApiNode.ws.partialDepth(
        getSpotPair,
        // WHAT THIS CALLBACK USED TO DO, AND WHY IT NO LONGER DOES IT
        //
        // It rebuilt a 20-level book straight out of this partialDepth frame
        // and emitted it as "orderBook" - raw Binance depth, with no health
        // verdict, no ladder check and no sequence number. That is a SECOND
        // derivation of the display, and this admin-triggered stream (see
        // pairManage.controller.js, which restarts it on every pair add/edit)
        // would happily paint a full, fresh-looking book straight over the
        // empty one the gated publisher had just correctly emitted - the exact
        // shape of the outage the gate exists to prevent, with the exact same
        // invisible symptom.
        //
        // The frame is now only a TRIGGER. The payload is built once, in
        // bookPublish, from the shared snapshot and behind the shared health
        // gate; publishOrderBook is serialised per pair, so a 100ms frame rate
        // collapses into at most one in-flight build.
        async (depth) => {
          if (depth) {
            let pairData = getSpotPair.find((el) => el.symbol == depth.symbol);
            if (pairData) {
              try {
                await publishOrderBook(String(pairData._id));
              } catch (err) {
                console.log("err on partialDepth publish---", err && err.message);
              }
            }
          }
        }
      );
    }
  } catch (err) {
    console.log("Error on websocketcall in binanceHelper ", err);
  }
};

export const spotTickerPriceWS = async () => {
  try {
    if (markDepth) {
      markDepth();
    }
    let getSpotPair = await SpotPair.aggregate([
      {
        $match: { botstatus: { $in: ["off", "binance"] } }
      },
      {
        $group: {
          _id: null,
          symbol: {
            $push: {
              $concat: [
                "$firstCurrencySymbol",
                {
                  $switch: {
                    branches: [
                      {
                        case: { $eq: ["$secondCurrencySymbol", "USD"] },
                        then: "USDT",
                      },
                    ],
                    default: "$secondCurrencySymbol",
                  },
                },
              ],
            },
          },
          pairData: {
            $push: {
              pairId: "$_id",
              symbol: {
                $concat: [
                  "$firstCurrencySymbol",
                  {
                    $switch: {
                      branches: [
                        {
                          case: { $eq: ["$secondCurrencySymbol", "USD"] },
                          then: "USDT",
                        },
                      ],
                      default: "$secondCurrencySymbol",
                    },
                  },
                ],
              },
            },
          },
        },
      },
    ]);
    if (
      getSpotPair &&
      getSpotPair.length > 0 &&
      getSpotPair[0].symbol &&
      getSpotPair[0].symbol.length > 0
    ) {
      markDepth = binanceApiNode.ws.ticker(
        getSpotPair[0].symbol,
        async (tickerdata) => {
          let pairData = getSpotPair[0].pairData.find(
            (el) => el.symbol == tickerdata.symbol
          );
          if (pairData) {
            let updateSpotPair = await SpotPair.findOneAndUpdate(
              {
                _id: pairData.pairId,
              },
              {
                low: tickerdata.low,
                high: tickerdata.high,
                changePrice: tickerdata.priceChange,
                change: tickerdata.priceChangePercent,
                firstVolume: tickerdata.volume,
                secondVolume: tickerdata.volumeQuote,
                last: tickerdata.bestBid,
                markPrice: tickerdata.bestBid,
                last_ask: tickerdata.bestAsk,
                last_bid: tickerdata.bestBid,
              },
              {
                new: true,
                fields: {
                  last: 1,
                  markPrice: 1,
                  low: 1,
                  high: 1,
                  firstVolume: 1,
                  secondVolume: 1,
                  changePrice: 1,
                  change: 1,
                  botstatus: 1,
                  secondCurrencySymbol: 1,
                  firstCurrencySymbol: 1
                },
              }
            ).lean();
            // updateSpotPair = updateSpotPair.toJSON()
            let pairDoc = await hget(
              "spotPairdata",
              updateSpotPair._id.toString()
            );
            if (!isEmpty(pairDoc)) {
              pairDoc = await JSON.parse(pairDoc);
              pairDoc["last"] = updateSpotPair.last;
              pairDoc["markPrice"] = updateSpotPair.markPrice;
              pairDoc["low"] = updateSpotPair.low;
              pairDoc["high"] = updateSpotPair.high;
              pairDoc["firstVolume"] = updateSpotPair.firstVolume;
              pairDoc["secondVolume"] = updateSpotPair.secondVolume;
              pairDoc["changePrice"] = updateSpotPair.changePrice;
              pairDoc["change"] = updateSpotPair.change;
              await hset(
                "spotPairdata",
                updateSpotPair._id.toString(),
                pairDoc
              );
            }
            socketEmitOne(
              "marketPrice",
              {
                pairId: pairData.pairId,
                data: updateSpotPair,
              },
              "spot"
            );
            await hset(
              "spot24hrsChange",
              updateSpotPair._id.toString(),
              updateSpotPair
            );
          }
        }
      );
    }
  } catch (err) {
    console.log("Error on ticker binance ", err);
  }
};

/**
 * Account Info
 */
export const accountInfo = async () => {
  try {
    let accountInfo = await binanceApiNode.accountInfo();

    if (accountInfo) {
      return {
        status: true,
        data: accountInfo,
      };
    }
    return {
      status: false,
    };
  } catch (err) {
    console.log("bianceaccountInfoaccountInfoerrrrrrrrrrrrrr", err);
    return {
      status: false,
    };
  }
};

/**
 * Balance Info
 * BODY : currencySymbol
 */
export const balanceInfo = async ({ currencySymbol }) => {
  try {
    let info = await accountInfo();
    if (!info.status) {
      return {
        status: false,
      };
    }

    let currencyBalance = info.data.balances.find(
      (el) => el.asset == currencySymbol
    );
    console.log("-------currencyBalance", currencyBalance);
    if (!currencyBalance) {
      return {
        status: false,
      };
    }
    return {
      status: true,
      data: currencyBalance,
    };
  } catch (err) {
    console.log("-------bainaceacccoutnerrr", err);
    return {
      status: false,
    };
  }
};
// balanceInfo({ currencySymbol: "BTC" });
// balanceInfo({ currencySymbol: "USDT" });
/**
 * Check Currency Balance
 * BODY : firstCurrency, secondCurrency, buyorsell, price, quantity
 */
export const checkBalance = async ({
  firstCurrencySymbol,
  secondCurrencySymbol,
  buyorsell,
  price,
  quantity,
  Market_orderValue,
  side,
}) => {
  try {
    let currencySymbol, orderValue;
    if (side == "limit") {
      price = parseFloat(price);
      quantity = parseFloat(quantity);
      if (buyorsell == "buy") {
        orderValue = price * quantity;
      } else if (buyorsell == "sell") {
        orderValue = quantity;
      }
    } else {
      orderValue = Market_orderValue;
    }

    currencySymbol =
      buyorsell == "buy" ? secondCurrencySymbol : firstCurrencySymbol;
    let balanceData = await balanceInfo({ currencySymbol });
    if (!balanceData.status) {
      return {
        status: false,
      };
    }
    console.log(
      "checkBalancecheckBalance",
      balanceData,
      orderValue,
      price,
      quantity,
      Market_orderValue
    );
    if (parseFloat(balanceData.data.free) > orderValue) {
      return {
        status: true,
      };
    } else {
      return {
        status: false,
      };
    }
  } catch (err) {
    console.log("bianacecheckBalancecheckBalance", err);
    return {
      status: false,
    };
  }
};

/**
 * Binance Order Place
 * firstCoin, secondCoin, side, price, quantity, orderType (limit, market), markupPercentage, minimumValue, markPrice
 */
export const orderPlace = async (reqBody, pairData) => {
  try {
    console.log("reqBody: ", reqBody);
    // const checkBinanceBalance = await checkBalance({
    //   firstCurrencySymbol: reqBody.firstCurrency,
    //   secondCurrencySymbol: replacePair(reqBody.secondCurrency),
    //   buyorsell: reqBody.buyorsell,
    //   price: reqBody.price,
    //   quantity: reqBody.quantity,
    //   Market_orderValue:
    //     reqBody.buyorsell == "buy" ? reqBody.orderValue : reqBody.amount,
    //   side: reqBody.orderType,
    // });

    // if (!checkBinanceBalance.status) {
    //   return {
    //     status: false,
    //   };
    // }

    if (reqBody.orderType == "limit") {
      return await limitOrderPlace({
        price: reqBody.price,
        quantity: reqBody.quantity,
        buyorsell: reqBody.buyorsell,
        markupPercentage: pairData.markupPercentage,
        minimumValue: pairData.minQuantity,
        firstCurrencySymbol: reqBody.firstCurrency,
        secondCurrencySymbol: reqBody.secondCurrency,
        OrderDetails: reqBody,
      });
    } else if (reqBody.orderType == "market") {
      return await marketOrderPlace(reqBody, pairData);
    }

    return {
      status: false,
    };
  } catch (err) {
    console.log("-----orderrrrrrrrrrrrrrplaceeeeeee", err);
    return {
      status: false,
    };
  }
};

export const limitOrderPlace = async ({
  price,
  quantity,
  buyorsell,
  markupPercentage,
  minimumValue,
  firstCurrencySymbol,
  secondCurrencySymbol,
  OrderDetails,
}) => {
  try {
    price = parseFloat(price);
    quantity = parseFloat(quantity);

    let withMarkupPrice;

    if (buyorsell == "buy") {
      withMarkupPrice = calculateMarkup(price, markupPercentage, "-");
    } else if (buyorsell == "sell") {
      withMarkupPrice = calculateMarkup(price, markupPercentage, "+");
    }

    let orderValue = quantity * withMarkupPrice;
    console.log(
      "lkimttttttttttttttttt",
      orderValue,
      quantity,
      withMarkupPrice,
      minimumValue
    );
    if (orderValue) {
      let orderOption = {
        symbol: firstCurrencySymbol + secondCurrencySymbol,
        side: buyorsell.toUpperCase(),
        type: "LIMIT",
        quantity: quantity,
        price: toFixed(withMarkupPrice, OrderDetails.secondFloatDigit),
      };

      let neworder = await binanceApiNode.order(orderOption);
      console.log("binanceApiNodelimitorder errrrrrrrrrrr", neworder);

      if (!neworder) {
        return {
          status: false,
        };
      }

      return {
        status: true,
        data: {
          orderId: neworder.orderId,
          status: neworder.status,
          executedQty: neworder.executedQty,
          origQty: neworder.origQty,
        },
      };
    } else {
      return {
        status: false,
      };
    }
  } catch (err) {
    console.log("OrderDetailsOrderDetailsOrderDetails", err);
    return {
      status: false,
    };
  }
};

export const marketOrderPlace = async (OrderDetails, pairData) => {
  try {
    console.log("---------------market entry-------------------------");
    console.log("OrderDetails: ", OrderDetails);
    let buyorsell = OrderDetails.buyorsell,
      firstCurrencySymbol = OrderDetails.firstCurrency,
      secondCurrencySymbol = OrderDetails.secondCurrency;

    // price = parseFloat(price);
    // quantity = parseFloat(quantity);

    // let withMarkupPrice;

    // if (buyorsell == "buy") {
    //   withMarkupPrice = calculateMarkup(price, markupPercentage, "-");
    // } else if (buyorsell == "sell") {
    //   withMarkupPrice = calculateMarkup(price, markupPercentage, "+");
    // }

    // let orderValue = quantity * withMarkupPrice;

    // if (orderValue >= minimumValue) {
    let cost = OrderDetails.buyorsell == "buy" ? "quoteOrderQty" : "quantity";

    let orderOption = {
      symbol: firstCurrencySymbol + secondCurrencySymbol,
      side: buyorsell.toUpperCase(),
      type: "MARKET",
      [cost]:
        OrderDetails.buyorsell == "buy"
          ? toFixed(OrderDetails.orderValue, OrderDetails.secondFloatDigit)
          : toFixed(OrderDetails.amount, OrderDetails.firstFloatDigit),
    };
    console.log("----------orderOption", orderOption);
    let binOrder = await binanceApiNode.order(orderOption);
    console.log("binOrder: ", binOrder);
    console.log("neworderneworderneworderneworder", binOrder);
    if (isEmpty(binOrder.status)) {
      return {
        status: false,
      };
    }

    OrderDetails.liquidityId = binOrder.orderId;
    OrderDetails.liquidityType = "binance";
    OrderDetails.isLiquidity = true;

    if (binOrder.status == "FILLED") {
      let binFill = binOrder;
      let uniqueId = Math.floor(Math.random() * 1000000000);
      let Biancerice = parseFloat(binFill.fills[0].price),
        binanceExecqudedQuantity = parseFloat(binFill.executedQty);
      let updateBal = 0;

      let markupPrice, markupQty;
      if (OrderDetails.buyorsell == "buy") {
        markupPrice = liquidityMarkup(
          Biancerice,
          pairData.markupPercentage,
          "+"
        );
        let BinOrderMarkPrice = markupPrice * binanceExecqudedQuantity;
        if (
          parseFloat(OrderDetails.orderValue) > parseFloat(BinOrderMarkPrice)
        ) {
          let retriveBal =
            parseFloat(OrderDetails.orderValue) - parseFloat(BinOrderMarkPrice);
          let updateBal = await moveBalanceSigned(
            "walletbalance_spot",
            OrderDetails.userId.toString() +
            "_" +
            OrderDetails.secondCurrencyId.toString(),
            retriveBal,
            { reason: "market_order_refund" }
          );
          passbook({
            userId: OrderDetails.userId,
            coin: OrderDetails.secondCurrency,
            currencyId: OrderDetails.secondCurrencyId,
            tableId: OrderDetails._id,
            beforeBalance: parseFloat(updateBal) - retriveBal,
            afterBalance: parseFloat(updateBal),
            amount: retriveBal,
            type: "spot_MarketOrder_Binance_exec_balretrive",
            category: "credit",
          });
        }
        markupQty = (markupPrice * binanceExecqudedQuantity) / markupPrice;
        console.log("markupQty: ", markupQty);
        console.log("markupPrice: ", markupPrice);
        console.log("binanceExecqudedQuantity: ", binanceExecqudedQuantity);
        console.log("Biancerice: ", Biancerice);
        updateBal = markupQty;
        console.log("updateBal: ", updateBal);
      } else if (OrderDetails.buyorsell == "sell") {
        markupPrice = liquidityMarkup(
          Biancerice,
          pairData.markupPercentage,
          "-"
        );
        markupQty = binanceExecqudedQuantity;
        updateBal = markupPrice * binanceExecqudedQuantity;
      }

      let CoinId =
        OrderDetails.buyorsell == "sell"
          ? OrderDetails.secondCurrencyId.toString()
          : OrderDetails.firstCurrencyId.toString();
      let UserId = OrderDetails.userId.toString();
      let userBalanceUpdate = await moveBalanceSigned(
        "walletbalance_spot",
        UserId + "_" + CoinId,
        updateBal,
        { reason: "binance_fill_credit" }
      );

      let beforBlance = userBalanceUpdate - updateBal,
        afterBalance = toFixed(parseFloat(userBalanceUpdate), 8),
        coinSymbole =
          OrderDetails.buyorsell == "sell"
            ? OrderDetails.secondCurrency
            : OrderDetails.firstCurrency;

      passbook({
        userId: UserId,
        coin: coinSymbole,
        currencyId: CoinId,
        tableId: OrderDetails._id,
        beforeBalance: beforBlance,
        afterBalance: afterBalance,
        amount: updateBal,
        type: "spot_MarketOrder_Binance_exec",
        category: "credit",
      });
      socketEmitOne(
        "updateTradeAsset",
        {
          currencyId: CoinId,
          spotBal: userBalanceUpdate,
        },
        UserId
      );
      markupQty = toFixedDown(markupQty, OrderDetails.firstFloatDigit);

      OrderDetails.status = "completed";
      OrderDetails.filledQuantity += markupQty;
      OrderDetails.averagePrice += markupPrice * markupQty;
      OrderDetails.price = markupPrice * markupQty;
      await newTradeHistory({
        buyOrderData: OrderDetails.buyorsell == "buy" ? OrderDetails : {},
        sellOrderData: OrderDetails.buyorsell == "sell" ? OrderDetails : {},
        uniqueId: uniqueId,
        execPrice: parseFloat(markupPrice),
        Maker: OrderDetails.buyorsell,
        execQuantity: markupQty,
      });
      await newOrderHistory(OrderDetails);
      await hset(
        "orderHistory_" + OrderDetails.userId.toString(),
        OrderDetails._id.toString(),
        OrderDetails
      );

      getOpenOrderSocket(OrderDetails.userId, OrderDetails.pairId);
      getOrderHistorySocket(OrderDetails.userId, OrderDetails.pairId);
      return {
        status: true,
      };
    } else {
      return {
        status: false,
      };
    }
  } catch (err) {
    console.log("Markett order", err);

    return {
      status: false,
    };
  }
};

export const calculateMarkup = (price, percentage, type = "+") => {
  price = parseFloat(price);
  percentage = parseFloat(percentage);

  if (!isEmpty(price)) {
    if (type == "+") {
      return price + price * (percentage / 100);
    } else if (type == "-") {
      return price - price * (percentage / 100);
    }
  }
  return 0;
};

/**
 * Cancel Order
 * symbol
 */
export const cancelOrder = async ({ firstCoin, secondCoin, binanceId }) => {
  try {
    console.log(
      "checkOrder.firstCurrencycheckOrder.firstCurrency",
      firstCoin,
      secondCoin,
      binanceId
    );
    let cancelOrder = await binanceApiNode.cancelOrder({
      symbol: firstCoin + secondCoin,
      orderId: binanceId,
    });
    console.log("biancecancelOrdercancelOrderstats", cancelOrder);

    if (cancelOrder) {
      return {
        status: true,
        data: cancelOrder,
      };
    } else {
      return {
        status: false,
      };
    }
  } catch (err) {
    console.log("binancebinancebinancebinancecacenlERRRRRR", err);
    return {
      status: false,
    };
  }
};

/**
 * Get Order Status
 * BODY : pairName, binanceOrderId
 */
export const orderStatus = async ({ pairName, binanceOrderId }) => {
  try {
    var orderstatus = await binanceApiNode.getOrder({
      symbol: pairName,
      orderId: binanceOrderId,
    });
    if (orderstatus) {
      return {
        status: true,
        data: orderstatus,
      };
    } else {
      return {
        status: false,
      };
    }
  } catch (err) {
    return {
      status: false,
    };
  }
};

/**
 * Check Binance Order Status
 */
export const checkStatus = async (req, res) => {
  try {
    let orderData = await SpotOrder.find({
      binType: true,
      status: { $in: ["open", "pending"] },
    });
    if (orderData && orderData.length > 0) {
      for (let item of orderData) {
        if (!isEmpty(item.binorderId)) {
          const orderStatus = await orderStatus({
            pairName: item.firstCurrency + item.secondCurrency,
            binanceOrderId: item.binorderId,
          });

          if (orderStatus.status) {
            respArray.push({
              binanceOrderId: orderStatus.data.orderId,
              binanceStatus: orderStatus.data.status,
              executedQty: orderStatus.data.executedQty,
              origQty: orderStatus.data.origQty,
            });
          }
        }
      }
    }
  } catch (err) { }
};

/**
 * Check Binance Order
 */
binOrderTask.start();
let binCronStart = false;
export const checkOrder = async () => {
  // binOrderTask.stop();
  try {
    if (binCronStart) {
      return false;
    }
    binCronStart = true;
    const orderList = await OrderHistory.find({
      isLiquidity: true,
      liquidityType: "binance",
      status: { $in: ["open", "pending", "conditional"] },
    });
    if (orderList && orderList.length > 0) {
      for (let orderData of orderList) {
        console.log("orderData: ", orderData);
        let binOrder = await orderStatus({
          pairName: orderData.firstCurrency + orderData.secondCurrency,
          binanceOrderId: parseFloat(orderData.liquidityId),
        });
        console.log("binOrder: ", binOrder);
        if (binOrder.status) {
          let pairData = await FetchpairData(orderData.pairId);
          let binData = binOrder.data;

          if (pairData && binOrder.data.status == "PARTIALLY_FILLED") {
            let uniqueId = Math.floor(Math.random() * 1000000000);
            let filledQty = Math.abs(
              orderData.filledQuantity + parseFloat(binData.executedQty)
            );

            orderData.filledQuantity = filledQty;
            orderData.averagePrice += orderData.price * filledQty;
            let inOrderVal =
              orderData.buyorsell == "sell"
                ? orderData.filledQuantity
                : orderData.price * orderData.filledQuantity;
            let inOrderCoinID =
              orderData.buyorsell == "sell"
                ? orderData.firstCurrencyId.toString()
                : orderData.secondCurrencyId.toString();
            let inOrder = await hincbyfloat(
              "walletbalance_spot_inOrder",
              UserId + "_" + inOrderCoinID,
              -inOrderVal
            );
            let balanceUpdate =
              orderData.buyorsell == "sell"
                ? orderData.price * binData.executedQty
                : binData.executedQty;
            let creditedBalance = balanceUpdate;
            //wallet
            let CoinId =
              orderData.buyorsell == "sell"
                ? orderData.secondCurrencyId.toString()
                : orderData.firstCurrencyId.toString();
            let UserId = orderData.userId.toString();
            let userBalanceUpdate = await moveBalanceSigned(
              "walletbalance_spot",
              UserId + "_" + CoinId,
              creditedBalance,
              { reason: "binance_fill_credit" }
            );
            let beforBlance =
              userBalanceUpdate - creditedBalance,
              afterBalance = userBalanceUpdate;
            passbook({
              userId: UserId,
              coin:
                orderData.buyorsell == "sell"
                  ? orderData.secondCurrency
                  : orderData.firstCurrency,
              currencyId: CoinId,
              tableId: orderData._id,
              beforeBalance: beforBlance,
              afterBalance: afterBalance,
              amount: creditedBalance,
              type: "spot_OrderMatch_Binance_exec",
              category: "credit",
            });
            socketEmitOne(
              "updateTradeAsset",
              {
                currencyId: CoinId,
                spotBal: userBalanceUpdate,
                inOrder,
              },
              UserId
            );
            await newOrderHistory(orderData);
            getOpenOrderSocket(orderData.userId, orderData.pairId);
            getOrderHistorySocket(orderData.userId, orderData.pairId);
          } else if (pairData && binOrder.data.status == "FILLED") {
            let uniqueId = Math.floor(Math.random() * 1000000000);
            let filledQty = Math.abs(
              orderData.filledQuantity + parseFloat(binData.executedQty)
            );

            orderData.status = "completed";
            orderData.filledQuantity = filledQty;
            orderData.averagePrice += orderData.price * binData.executedQty;

            let balanceUpdate =
              orderData.buyorsell == "sell"
                ? orderData.price * binData.executedQty
                : binData.executedQty;
            let creditedBalance = balanceUpdate;
            //wallet
            let inOrderVal =
              orderData.buyorsell == "sell"
                ? orderData.filledQuantity
                : orderData.price * orderData.filledQuantity;
            let inOrderCoinID =
              orderData.buyorsell == "sell"
                ? orderData.firstCurrencyId.toString()
                : orderData.secondCurrencyId.toString();
            let inOrder = await hincbyfloat(
              "walletbalance_spot_inOrder",
              UserId + "_" + inOrderCoinID,
              -inOrderVal
            );
            let CoinId =
              orderData.buyorsell == "sell"
                ? orderData.secondCurrencyId.toString()
                : orderData.firstCurrencyId.toString();
            let UserId = orderData.userId.toString();
            let userBalanceUpdate = await moveBalanceSigned(
              "walletbalance_spot",
              UserId + "_" + CoinId,
              creditedBalance,
              { reason: "binance_fill_credit" }
            );
            let beforBlance =
              userBalanceUpdate - creditedBalance,
              afterBalance = userBalanceUpdate;
            passbook({
              userId: UserId,
              coin:
                orderData.buyorsell == "sell"
                  ? orderData.secondCurrency
                  : orderData.firstCurrency,
              currencyId: CoinId,
              tableId: orderData._id,
              beforeBalance: beforBlance,
              afterBalance: afterBalance,
              amount: creditedBalance,
              type: "spot_OrderMatch_Binance_exec",
              category: "credit",
            });
            socketEmitOne(
              "updateTradeAsset",
              {
                currencyId: CoinId,
                spotBal: userBalanceUpdate,
                inOrder,
              },
              UserId
            );

            //saveOrder

            console.log("bianceFILLLER", filledQty, orderData.price);
            newTradeHistory({
              buyOrderData: orderData.buyorsell == "buy" ? orderData : {},
              sellOrderData: orderData.buyorsell == "sell" ? orderData : {},
              uniqueId: uniqueId,
              execPrice: orderData.price,
              Maker: orderData.buyorsell,
              execQuantity: binData.executedQty,
              ordertype: "Binance",
            });
            orderData.orderDate = new Date(orderData.orderDate).getTime();
            await hset(
              "orderHistory_" + orderData.userId.toString(),
              orderData._id.toString(),
              orderData
            );
            // getOpenOrderSocket(current_buy.userId, current_buy, 'del');
            await hdel(
              `${orderData.buyorsell}OpenOrders_` + orderData.pairId.toString(),
              orderData._id.toString()
            );
            await newOrderHistory(orderData);
            getOpenOrderSocket(orderData.userId, orderData.pairId);
            getOrderHistorySocket(orderData.userId, orderData.pairId);
          } else if (pairData && binOrder.data.status == "CANCELED") {
            let filledQty = Math.abs(
              orderData.openQuantity - parseFloat(orderData.filledQuantity)
            );

            orderData.status = "cancel";
            let balanceUpdate =
              orderData.buyorsell == "buy"
                ? orderData.price * filledQty
                : filledQty;

            //wallet
            let CoinId =
              orderData.buyorsell == "buy"
                ? orderData.secondCurrencyId.toString()
                : orderData.firstCurrencyId.toString();
            let UserId = orderData.userId.toString();
            let userBalanceUpdate = await moveBalanceSigned(
              "walletbalance_spot",
              UserId + "_" + CoinId,
              balanceUpdate,
              { reason: "binance_fill_credit" }
            );
            let inOrder = await hincbyfloat(
              "walletbalance_spot_inOrder",
              UserId + "_" + CoinId,
              -balanceUpdate
            );
            let beforBlance = userBalanceUpdate - balanceUpdate,
              afterBalance = userBalanceUpdate;
            passbook({
              userId: UserId,
              coin:
                orderData.buyorsell == "buy"
                  ? orderData.secondCurrency
                  : orderData.firstCurrency,
              currencyId: CoinId,
              tableId: orderData._id,
              beforeBalance: beforBlance,
              afterBalance: afterBalance,
              amount: balanceUpdate,
              type: "spot_OrderMatch_Binance_Cancel",
              category: "debit",
            });
            socketEmitOne(
              "updateTradeAsset",
              {
                currencyId: CoinId,
                spotBal: userBalanceUpdate,
                inOrder,
              },
              orderData.userId
            );
            orderData.orderDate = new Date(orderData.orderDate).getTime();
            //saveOrder
            await hset(
              "orderHistory_" + orderData.userId.toString(),
              orderData._id.toString(),
              orderData
            );

            // getOpenOrderSocket(current_buy.userId, current_buy, 'del');
            await hdel(
              `${orderData.buyorsell}OpenOrders_` + orderData.pairId.toString(),
              orderData._id.toString()
            );
            await newOrderHistory(orderData);
            getOpenOrderSocket(orderData.userId, orderData.pairId);
            getOrderHistorySocket(orderData.userId, orderData.pairId);
          }
        }
      }
    }
    binCronStart = false;
  } catch (err) {
    console.log("------err", err);
    binCronStart = false;
  }
};

/**
 * Recent Trade - uses Binance public REST API (no auth required)
 */
export const recentTrade = async ({
  firstCurrencySymbol,
  secondCurrencySymbol,
}) => {
  try {
    secondCurrencySymbol = replacePair(secondCurrencySymbol);
    const symbol = firstCurrencySymbol + secondCurrencySymbol;

    // Use public Binance API endpoint (no authentication required).
    // aggTrades, matching the @aggTrade socket stream this seeds: one row per
    // taker order rather than one per fill. /api/v3/trades returned every fill
    // of a sweep, which is ~60% duplicate-looking rows on one screen.
    // The limit matches the client's MAX_TRADE_ROWS so the seed fills the tape.
    const response = await axios.get(`https://api.binance.com/api/v3/aggTrades`, {
      params: {
        symbol: symbol,
        limit: 60
      },
      timeout: 5000
    });

    let recentTrade = [];
    if (Array.isArray(response.data)) {
      response.data.forEach((el) => {
        recentTrade.push({
          // See the note in lib/binanceWebSocket.js handleTradeUpdate: without
          // Binance's per-trade id the client's dedupe key is
          // createdAt|price|qty|Type, which the fills of a single sweep share.
          // Carrying it also makes a trade dedupe against ITSELF across the two
          // paths, which the differing createdAt types otherwise prevent.
          // aggTrades names its fields a/p/q/T/m where trades used
          // id/price/qty/time/isBuyerMaker.
          _id: el.a,
          createdAt: new Date(el.T),
          // m=true means buyer was passive (seller was aggressive/market sell) = red/sell
          // m=false means seller was passive (buyer was aggressive/market buy) = green/buy
          Type: el.m ? "sell" : "buy",
          tradePrice: parseFloat(el.p),
          tradeQty: parseFloat(el.q),
        });
      });
    }

    return recentTrade;
  } catch (err) {
    console.log("[recentTrade] err: ", err.message);
    return [];
  }
};

export const getSpotPair = async () => {
  try {
    let pairLists = await SpotPair.find(
      { botstatus: "off" },
      {
        firstCurrencySymbol: 1,
        secondCurrencySymbol: 1,
      }
    );
    if (pairLists && pairLists.length > 0) {
      recentTradeWS(pairLists);
    }
    return true;
  } catch (err) {
    return false;
  }
};

export const recentTradeWS = async (pairList) => {
  try {
    if (RecentDepth) {
      RecentDepth();
    }
    let symbolList = lodash.map(pairList, (item) => {
      return item.firstCurrencySymbol + replacePair(item.secondCurrencySymbol);
    });

    if (symbolList && symbolList.length > 0) {
      RecentDepth = binanceApiNode.ws.trades(symbolList, async (trade) => {
        if (trade) {
          let pairData = pairList.find(
            (el) =>
              el.firstCurrencySymbol + replacePair(el.secondCurrencySymbol) ==
              trade.symbol
          );
          let recentTrade = [
            {
              createdAt: new Date(trade.tradeTime),
              // isBuyerMaker=true means buyer was passive (seller was aggressive/market sell) = red/sell
              // isBuyerMaker=false means seller was passive (buyer was aggressive/market buy) = green/buy
              Type: trade.isBuyerMaker ? "sell" : "buy",
              tradePrice: trade.price,
              tradeQty: trade.quantity,
            },
          ];
          setDepthBinanceHist(
            {
              PairId: pairData._id,
              tradePrice: trade.price,
              tradeQty: trade.quantity,
            },
            trade.isBuyerMaker ? "sell" : "buy"
          );
          let pair =
            pairData.firstCurrencySymbol + pairData.secondCurrencySymbol;
          socketEmitOne(
            "recentTrade",
            {
              pairId: pairData._id,
              data: recentTrade,
            },
            pair
          );
        }
      });
    }
  } catch (err) {
    console.log(err, "Error on recentTradeWS");
  }
};

// Initial Function Call
// Temporarily disabled all due to WebSocket errors
// getSpotPair();
// spotOrderBookWS();
// spotTickerPriceWS();

/**
 * Update prices from Binance for all active pairs with botstatus='binance'
 * Called by cron job every 30 seconds
 */
export const updateBinancePrices = async () => {
  try {
    console.log('[updateBinancePrices] Starting...');
    const pairs = await SpotPair.find({ status: 'active', botstatus: 'binance' }).lean();
    console.log('[updateBinancePrices] Found pairs:', pairs.length);

    for (const pair of pairs) {
      try {
        const pairName = pair.tikerRoot || `${pair.firstCurrencySymbol}${pair.secondCurrencySymbol}`;
        console.log('[updateBinancePrices] Processing pair:', pairName);

        // Convert USD to USDT for Binance API
        const binanceSymbol = pair.secondCurrencySymbol === "USD"
          ? pair.firstCurrencySymbol + "USDT"
          : pair.firstCurrencySymbol + pair.secondCurrencySymbol;

        // THE WHOLE 24H WINDOW IN ONE READING.
        //
        // /api/v3/ticker/price answers "what is it worth now" and nothing else,
        // so everything else on the header used to be manufactured here: a
        // range rebuilt from the previous tick (hence a "24h low" that could
        // rise $660 in 14 seconds, and a "24h high" that was usually just the
        // last price) and two INDEPENDENT Math.random() draws for volume and
        // turnover (hence 4x-1400x disagreement between two numbers that are
        // the same trades in different units).
        //
        // /api/v3/ticker/24hr answers exactly the question the header asks, and
        // answers all of it from one window, so high/low/volume/turnover/change
        // agree with each other and with the price by construction. See
        // lib/ticker24h.js for the identities and why a failing tick is dropped
        // rather than patched.
        const axios = (await import("axios")).default;
        const tickerResponse = await axios.get(`https://api.binance.com/api/v3/ticker/24hr`, {
          params: { symbol: binanceSymbol },
          timeout: 5000,
        });

        const ticker = buildPairPayloads(pair, tickerResponse.data);

        if (!ticker.ok) {
          // Keep the previous snapshot. It is stale but it is true, and every
          // consumer (header, /market, pair list, marketPrice) reads the same
          // cache, so they stay in agreement with each other either way.
          console.log(
            '[updateBinancePrices] Incoherent ticker rejected for',
            pairName, '-', ticker.reason
          );
          continue;
        }

        // ONE stats object behind all three sinks - see buildPairPayloads. The
        // socket tick cannot disagree with the cache, and the cache cannot
        // disagree with what the next REST call returns.
        const { stats, updatedPair, changeData, socketData } = ticker;

        // Update both Redis caches (hset will JSON.stringify the data)
        await hset('spotPairdata', pair._id.toString(), updatedPair);
        await hset('spot24hrsChange', pair._id.toString(), changeData);

        // Persist the same window to the pair document. getPairList falls back
        // to SpotPair when the redis cache is cold (a restart, a flush), and
        // that fallback used to serve whatever the long-disabled ticker socket
        // last wrote - a 24h range from another day beside a live price.
        try {
          await SpotPair.updateOne({ _id: pair._id }, { $set: stats });
        } catch (dbErr) {
          console.log('[updateBinancePrices] Could not persist stats for', pairName, ':', dbErr.message);
        }

        // Emit updated price via socket (frontend listens for 'marketPrice')
        // Format expected by frontend: { pairId, data: { markPrice, ... } }
        //
        // THE TICK CARRIES THE 24H FIELDS TOO. It used to carry only
        // markPrice/last/change, and the market table overwrites its row from
        // whatever the tick contains - so 30 seconds after /market loaded,
        // every 24h high/low/volume cell on it read 0, while the spot header
        // (which merges instead of replacing) sat on a frozen snapshot that
        // the live price beside it kept walking past.
        socketEmitAll('marketPrice', {
          pairId: pair._id.toString(),
          data: socketData
        });
        console.log('[updateBinancePrices] Updated price for', pairName, ':', stats.last);
      } catch (err) {
        console.log('[updateBinancePrices] Error processing pair:', err.message);
      }
    }
    console.log('[updateBinancePrices] Completed');
  } catch (err) {
    console.log('[updateBinancePrices] Error:', err.message);
  }
};

/**
 * REMOVED: updateOrderbookDepth().
 *
 * It polled the Binance REST depth endpoint every 3s, rewrote the
 * buy_depth_binance_/sell_depth_binance_ redis mirror, and emitted its own
 * socketEmitAll("orderBook", ...) - a raw, ungated book with no health verdict
 * attached, from a THIRD derivation of the depth. Its cron was disabled when
 * lib/binanceWebSocket.js took over the mirror (see config/cron.js), leaving
 * nothing that called it, but re-enabling that one commented-out line would
 * have put an unhealth-gated book back on the wire behind the gated publisher's
 * back. lib/binanceWebSocket.js owns the mirror; bookPublish.controller.js owns
 * the emit.
 */

/**
 * Update chart candlestick data from Binance
 * Called by cron job every minute to update chart cache
 */
export const updateChartData = async () => {
  try {
    console.log('[updateChartData] Starting...');
    const pairs = await SpotPair.find({ status: 'active', botstatus: 'binance' }).lean();
    console.log('[updateChartData] Found pairs:', pairs.length);
    const intervals = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];

    for (const pair of pairs) {
      try {
        const pairName = pair.tikerRoot || `${pair.firstCurrencySymbol}${pair.secondCurrencySymbol}`;
        // Convert USD to USDT for Binance API
        const binancePairName = pairName.endsWith("USD")
          ? pairName.slice(0, -3) + "USDT"
          : pairName;

        for (const interval of intervals) {
          try {
            // Fetch latest candlestick from Binance
            const axios = (await import("axios")).default;
            const klinesResponse = await axios.get(`https://api.binance.com/api/v3/klines`, {
              params: { symbol: binancePairName, interval: interval, limit: 1 },
              timeout: 3000,
            });

            const klines = klinesResponse.data;
            if (Array.isArray(klines) && klines.length > 0) {
              const latestCandle = klines[0];
              // [openTime, open, high, low, close, volume, ...]
              const candleData = {
                date: new Date(latestCandle[0]),
                open: parseFloat(latestCandle[1]),
                high: parseFloat(latestCandle[2]),
                low: parseFloat(latestCandle[3]),
                close: parseFloat(latestCandle[4]),
                volume: parseFloat(latestCandle[5]),
              };

              // Update chart history cache for this interval
              await hset(`chartHistory_${interval}`, pairName, candleData);

              // Emit via socket for real-time chart updates
              socketEmitAll("chartUpdate", {
                pair: pairName,
                pairId: pair._id.toString(),
                interval: interval,
                candle: candleData,
              });
            }
          } catch (err) {
            console.log('[updateChartData] Error for interval', interval, ':', err.message);
          }
        }
      } catch (err) {
        console.log('[updateChartData] Error processing pair:', err.message);
      }
    }
    console.log('[updateChartData] Completed');
  } catch (err) {
    console.log('[updateChartData] Error:', err.message);
  }
};

export const liquidityMarkup = (price, percentage, type = "+") => {
  price = parseFloat(price);
  percentage = parseFloat(percentage);

  if (!isEmpty(price)) {
    if (type == "+") {
      return price + price * (percentage / 100);
    } else if (type == "-") {
      return price - price * (percentage / 100);
    }
  }
  return 0;
};
