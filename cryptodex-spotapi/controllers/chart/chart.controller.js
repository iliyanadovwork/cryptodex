// import package
import url from "url";
import mongoose from "mongoose";

// import model
import {
  SpotPair,
  TradeHistory,
  ChartSchema,
} from "../../models/index.js";

// import config
import { nodeBinanceAPI } from "../../config/binance.js";

import * as symbolsDatabase from "./symbols_database.js";
import { RequestProcessor } from "./request-processor.js";
import { getSymbol } from "./symbols_database.js";

// import lib
import { replacePair } from "../../lib/pairHelper.js";
const requestProcessor = new RequestProcessor(symbolsDatabase);

import {
  hset,
  hget,
  hgetall,
  hincby,
  hincbyfloat,
  hdel,
  hdetall,
} from "../redis.controller.js";
import { getActivePairs } from "../spot.controller.js";
import isEmpty from "../../lib/isEmpty.js";
// import grpc

/**
 * Get Chart markets
 * METHOD : GET
 * URL : /api/markets
 */
export const getMarketsData = (req, res) => {
  SpotPair.aggregate(
    [
      {
        $lookup: {
          from: "currency",
          localField: "firstCurrencyId",
          foreignField: "_id",
          as: "firstCurrencyInfo",
        },
      },
      { $unwind: "$firstCurrencyInfo" },

      {
        $lookup: {
          from: "currency",
          localField: "secondCurrencyId",
          foreignField: "_id",
          as: "secondCurrencyInfo",
        },
      },
      { $unwind: "$secondCurrencyInfo" },

      {
        $project: {
          _id: 0,
          name: {
            $concat: [
              "$firstCurrencyInfo.currencySymbol",
              "$secondCurrencyInfo.currencySymbol",
            ],
          },
          type: "crypto",
          exchange: "Cryptodex",
        },
      },
    ],
    (err, spotpairData) => {
      if (err) {
        return res.status(200).json([]);
      }
      return res.status(200).json(spotpairData);
    }
  );
};

/**
 * Last-resort guard for the datafeed handlers: Express ignores the promise
 * returned by a route handler, so an unhandled rejection here would kill the
 * whole process. Answer with the UDF error payload instead.
 */
const sendChartError = (res, err) => {
  console.log("err------chart request------- ", err);
  if (!res.headersSent) {
    res.status(200).json({
      s: "error",
      errmsg: (err && err.message) || String(err),
    });
  }
};

/**
 * Get Chart Data
 * METHOD : GET
 * URL : /api/chart/:config
 */
export const getChartData = (req, res) => {
  let uri = url.parse(req.url, true);
  let action = uri.pathname;
  switch (action) {
    case "/chart/config":
      action = "/config";
      break;
    case "/chart/time":
      action = "/time";
      break;
    case "/chart/symbols":
      action = "/symbols";
      break;
    case "/chart/history":
      action = "/history";
      break;
  }
  return requestProcessor
    .processRequest(action, uri.query, res, "spot")
    .catch((err) => sendChartError(res, err));
};

export const old_chart = async ({ pairName, timeType, startDateTimestamp }) => {
  try {
    let pairList = getSymbol();
    if (pairList && pairList.length > 0) {
      let pairData = pairList.find((el) => el.name == pairName);

      if (pairData) {
        // Convert pairName (e.g., "SOLUSD") to Binance format (e.g., "SOLUSDT")
        let binancePairName = pairName;
        if (pairName.endsWith("USD")) {
          binancePairName = pairName.slice(0, -3) + "USDT";
        }

        // Fetch candlesticks from Binance
        const rawData = await nodeBinanceAPI.candlesticks(binancePairName, timeType);

        // Convert new Binance format (array of objects) to expected format (array of arrays)
        let chartData = [];
        if (Array.isArray(rawData)) {
          if (rawData.length > 0 && typeof rawData[0] === 'object') {
            // New format: array of objects {openTime, open, high, low, close, volume, ...}
            chartData = rawData.map(candle => [
              candle.openTime,
              candle.open,
              candle.high,
              candle.low,
              candle.close,
              candle.volume
            ]);
          } else if (rawData.length > 0 && Array.isArray(rawData[0])) {
            // Old format: array of arrays [time, open, high, low, close, volume]
            chartData = rawData;
          }
        }

        return {
          chartData: chartData,
          callBy: "binance",
        };
      }
      return [];
    }
    return [];
  } catch (err) {
    console.log("err------chart------- ", err);
    return [];
  }
};

async function Old_chartData({ pairName, resol }) {
  try {
    let project = {
      Date: "$Date",
      pair: "$pair",
      low: "$low",
      high: "$high",
      open: "$open",
      close: "$close",
      volume: "$volume",
      exchange: "Cryptodex",
    };

    var _trGroup = {};
    if (resol) {
      if (resol == "1d") {
        _trGroup = {
          _id: {
            year: {
              $year: "$createdAt",
            },
            month: {
              $month: "$createdAt",
            },
            day: {
              $dayOfMonth: "$createdAt",
            },
            hour: { $hour: "$createdAt" },
            minute: {
              $add: [
                {
                  $subtract: [
                    { $minute: "$createdAt" },
                    { $mod: [{ $minute: "$createdAt" }, +1440] },
                  ],
                },
                +1440,
              ],
            },
          },
          Date: { $last: "$createdAt" },
          pair: { $first: "$pairName" },
          low: { $min: "$tradePrice" },
          high: { $max: "$tradePrice" },
          open: { $first: "$tradePrice" },
          close: { $last: "$tradePrice" },
          volume: { $sum: "$tradeQty" },
        };
      } else if (resol == "1W") {
        _trGroup = {
          _id: {
            year: {
              $year: "$createdAt",
            },
            month: {
              $month: "$createdAt",
            },
            week: { $week: "$createdAt" },
          },
          Date: { $last: "$createdAt" },
          pair: { $first: "$pairName" },
          low: { $min: "$tradePrice" },
          high: { $max: "$tradePrice" },
          open: { $first: "$tradePrice" },
          close: { $last: "$tradePrice" },
          volume: { $sum: "$tradeQty" },
        };
      } else if (resol == "1M") {
        _trGroup = {
          _id: {
            year: {
              $year: "$createdAt",
            },
            month: {
              $month: "$createdAt",
            },
          },
          Date: { $last: "$createdAt" },
          pair: { $first: "$pairName" },
          low: { $min: "$tradePrice" },
          high: { $max: "$tradePrice" },
          open: { $first: "$tradePrice" },
          close: { $last: "$tradePrice" },
          volume: { $sum: "$tradeQty" },
        };
      } else if (resol == "1m") {
        _trGroup = {
          _id: {
            year: {
              $year: "$createdAt",
            },
            month: {
              $month: "$createdAt",
            },
            day: {
              $dayOfMonth: "$createdAt",
            },
            hour: { $hour: "$createdAt" },
            minute: { $minute: "$createdAt" },
          },
          Date: { $last: "$createdAt" },
          pair: { $first: "$pairName" },
          low: { $min: "$tradePrice" },
          high: { $max: "$tradePrice" },
          open: { $first: "$tradePrice" },
          close: { $last: "$tradePrice" },
          volume: { $sum: "$tradeQty" },
        };
      } else if (resol == "5m") {
        _trGroup = {
          _id: {
            year: {
              $year: "$createdAt",
            },
            month: {
              $month: "$createdAt",
            },
            day: {
              $dayOfMonth: "$createdAt",
            },
            hour: { $hour: "$createdAt" },
            minute: {
              $subtract: [
                { $minute: "$createdAt" },
                { $mod: [{ $minute: "$createdAt" }, 5] },
              ],
            },
          },
          Date: { $last: "$createdAt" },
          pair: { $first: "$pairName" },
          low: { $min: "$tradePrice" },
          high: { $max: "$tradePrice" },
          open: { $first: "$tradePrice" },
          close: { $last: "$tradePrice" },
          volume: { $sum: "$tradeQty" },
        };
      } else if (resol == "15m") {
        _trGroup = {
          _id: {
            year: {
              $year: "$createdAt",
            },
            month: {
              $month: "$createdAt",
            },
            day: {
              $dayOfMonth: "$createdAt",
            },
            hour: { $hour: "$createdAt" },
            minute: {
              $subtract: [
                { $minute: "$createdAt" },
                { $mod: [{ $minute: "$createdAt" }, 15] },
              ],
            },
          },
          Date: { $last: "$createdAt" },
          pair: { $first: "$pairName" },
          low: { $min: "$tradePrice" },
          high: { $max: "$tradePrice" },
          open: { $first: "$tradePrice" },
          close: { $last: "$tradePrice" },
          volume: { $sum: "$tradeQty" },
        };
      } else if (resol == "30m") {
        _trGroup = {
          _id: {
            year: {
              $year: "$createdAt",
            },
            month: {
              $month: "$createdAt",
            },
            day: {
              $dayOfMonth: "$createdAt",
            },
            hour: { $hour: "$createdAt" },
            minute: {
              $subtract: [
                { $minute: "$createdAt" },
                { $mod: [{ $minute: "$createdAt" }, 30] },
              ],
            },
          },
          Date: { $last: "$createdAt" },
          pair: { $first: "$pairName" },
          low: { $min: "$tradePrice" },
          high: { $max: "$tradePrice" },
          open: { $first: "$tradePrice" },
          close: { $last: "$tradePrice" },
          volume: { $sum: "$tradeQty" },
        };
      } else if (resol == "1h") {
        _trGroup = {
          _id: {
            year: {
              $year: "$createdAt",
            },
            month: {
              $month: "$createdAt",
            },
            day: {
              $dayOfMonth: "$createdAt",
            },
            hour: { $hour: "$createdAt" },
          },
          Date: { $last: "$createdAt" },
          pair: { $first: "$pairName" },
          low: { $min: "$tradePrice" },
          high: { $max: "$tradePrice" },
          open: { $first: "$tradePrice" },
          close: { $last: "$tradePrice" },
          volume: { $sum: "$tradeQty" },
        };
      } else if (resol == "4h") {
        _trGroup = {
          _id: {
            year: {
              $year: "$createdAt",
            },
            month: {
              $month: "$createdAt",
            },
            day: {
              $dayOfMonth: "$createdAt",
            },
            hour: {
              $subtract: [
                { $hour: "$createdAt" },
                { $mod: [{ $hour: "$createdAt" }, 4] },
              ],
            },
          },
          Date: { $last: "$createdAt" },
          pair: { $first: "$pairName" },
          low: { $min: "$tradePrice" },
          high: { $max: "$tradePrice" },
          open: { $first: "$tradePrice" },
          close: { $last: "$tradePrice" },
          volume: { $sum: "$tradeQty" },
        };
      } else {
        resol = 1440;
        _trProject = {
          yr: {
            $year: "$createdAt",
          },
          mn: {
            $month: "$createdAt",
          },
          dt: {
            $dayOfMonth: "$createdAt",
          },
          hour: {
            $hour: "$createdAt",
          },
          minute: { $minute: "$createdAt" },
          tradeQty: 1,
          tradePrice: 1,
          pair: "$pairname",
          modifiedDate: "$createdAt",
        };
        _trGroup = {
          _id: {
            year: "$yr",
            month: "$mn",
            day: "$dt",
            hour: "$hour",
            minute: {
              $add: [
                {
                  $subtract: [
                    { $minute: "$modifiedDate" },
                    { $mod: [{ $minute: "$modifiedDate" }, +resol] },
                  ],
                },
              ],
            },
          },
          count: {
            $sum: 1,
          },
          Date: { $last: "$modifiedDate" },
          pair: { $first: "$pairName" },
          low: { $min: "$tradePrice" },
          high: { $max: "$tradePrice" },
          open: { $first: "$tradePrice" },
          close: { $last: "$tradePrice" },
          volume: { $sum: "$tradeQty" },
        };
      }
    }
    let chartDoc = await TradeHistory.aggregate([
      {
        $match: {
          pairName: pairName,
          status: "completed",
          // "buyorsell": "sell"
        },
      },
      {
        $group: _trGroup,
      },
      {
        $project: project,
      },
      {
        $sort: {
          Date: 1,
        },
      },
    ]);
    return chartDoc;
  } catch (e) {
    return [];
  }
}

async function chartData({
  pairName,
  resol,
  startDateTimestamp,
  endDateTimestamp,
}) {
  try {
    let project = {
      Date: "$Date",
      pair: "$pair",
      low: "$low",
      high: "$high",
      open: "$open",
      close: "$close",
      // volume: "$volume",
      exchange: "Cryptodex",
    };

    var _trGroup = {};
    if (resol) {
      if (resol == "1d") {
        _trGroup = {
          _id: {
            year: {
              $year: "$date",
            },
            month: {
              $month: "$date",
            },
            day: {
              $dayOfMonth: "$date",
            },
            hour: { $hour: "$date" },
            minute: {
              $add: [
                {
                  $subtract: [
                    { $minute: "$date" },
                    { $mod: [{ $minute: "$date" }, +1440] },
                  ],
                },
                +1440,
              ],
            },
          },
          Date: { $last: "$date" },
          pair: { $first: "$pair" },
          low: { $min: "$low" },
          high: { $max: "$high" },
          open: { $first: "$open" },
          close: { $last: "$close" },
          // volume: { $sum: "$tradeQty" },
        };
      } else if (resol == "1W") {
        _trGroup = {
          _id: {
            year: {
              $year: "$date",
            },
            month: {
              $month: "$date",
            },
            week: { $week: "$date" },
          },
          Date: { $last: "$date" },
          pair: { $first: "$pair" },
          low: { $min: "$low" },
          high: { $max: "$high" },
          open: { $first: "$open" },
          close: { $last: "$close" },
          // volume: { $sum: "$tradeQty" },
        };
      } else if (resol == "1M") {
        _trGroup = {
          _id: {
            year: {
              $year: "$date",
            },
            month: {
              $month: "$date",
            },
          },
          Date: { $last: "$date" },
          pair: { $first: "$pair" },
          low: { $min: "$low" },
          high: { $max: "$high" },
          open: { $first: "$open" },
          close: { $last: "$close" },
          // volume: { $sum: "$tradeQty" },
        };
      } else if (resol == "1m") {
        // console.log("--------------1m");
        _trGroup = {
          _id: {
            year: {
              $year: "$date",
            },
            month: {
              $month: "$date",
            },
            day: {
              $dayOfMonth: "$date",
            },
            hour: { $hour: "$date" },
            minute: { $minute: "$date" },
          },
          Date: { $last: "$date" },
          pair: { $first: "$pair" },
          low: { $min: "$low" },
          high: { $max: "$high" },
          open: { $first: "$open" },
          close: { $last: "$close" },
          // volume: { $sum: "$tradeQty" },
        };
      } else if (resol == "5m") {
        _trGroup = {
          _id: {
            year: {
              $year: "$date",
            },
            month: {
              $month: "$date",
            },
            day: {
              $dayOfMonth: "$date",
            },
            hour: { $hour: "$date" },
            minute: {
              $subtract: [
                { $minute: "$date" },
                { $mod: [{ $minute: "$date" }, 5] },
              ],
            },
          },
          Date: { $last: "$date" },
          pair: { $first: "$pair" },
          low: { $min: "$low" },
          high: { $max: "$high" },
          open: { $first: "$open" },
          close: { $last: "$close" },
          // volume: { $sum: "$tradeQty" },
        };
      } else if (resol == "15m") {
        _trGroup = {
          _id: {
            year: {
              $year: "$date",
            },
            month: {
              $month: "$date",
            },
            day: {
              $dayOfMonth: "$date",
            },
            hour: { $hour: "$date" },
            minute: {
              $subtract: [
                { $minute: "$date" },
                { $mod: [{ $minute: "$date" }, 15] },
              ],
            },
          },
          Date: { $last: "$date" },
          pair: { $first: "$pair" },
          low: { $min: "$low" },
          high: { $max: "$high" },
          open: { $first: "$open" },
          close: { $last: "$close" },
          // volume: { $sum: "$tradeQty" },
        };
      } else if (resol == "30m") {
        _trGroup = {
          _id: {
            year: {
              $year: "$date",
            },
            month: {
              $month: "$date",
            },
            day: {
              $dayOfMonth: "$date",
            },
            hour: { $hour: "$date" },
            minute: {
              $subtract: [
                { $minute: "$date" },
                { $mod: [{ $minute: "$date" }, 30] },
              ],
            },
          },
          Date: { $last: "$date" },
          pair: { $first: "$pair" },
          low: { $min: "$low" },
          high: { $max: "$high" },
          open: { $first: "$open" },
          close: { $last: "$close" },
          // volume: { $sum: "$tradeQty" },
        };
      } else if (resol == "1h") {
        _trGroup = {
          _id: {
            year: {
              $year: "$date",
            },
            month: {
              $month: "$date",
            },
            day: {
              $dayOfMonth: "$date",
            },
            hour: { $hour: "$date" },
          },
          Date: { $last: "$date" },
          pair: { $first: "$pair" },
          low: { $min: "$low" },
          high: { $max: "$high" },
          open: { $first: "$open" },
          close: { $last: "$close" },
          // volume: { $sum: "$tradeQty" },
        };
      } else if (resol == "4h") {
        _trGroup = {
          _id: {
            year: {
              $year: "$date",
            },
            month: {
              $month: "$date",
            },
            day: {
              $dayOfMonth: "$date",
            },
            hour: {
              $subtract: [
                { $hour: "$date" },
                { $mod: [{ $hour: "$date" }, 4] },
              ],
            },
          },
          Date: { $last: "$date" },
          pair: { $first: "$pair" },
          low: { $min: "$low" },
          high: { $max: "$high" },
          open: { $first: "$open" },
          close: { $last: "$close" },
          // volume: { $sum: "$tradeQty" },
        };
      } else {
        resol = 1440;
        _trProject = {
          yr: {
            $year: "$date",
          },
          mn: {
            $month: "$date",
          },
          dt: {
            $dayOfMonth: "$date",
          },
          hour: {
            $hour: "$date",
          },
          minute: { $minute: "$date" },
          tradeQty: 1,
          tradePrice: 1,
          pair: "$pairname",
          modifiedDate: "$date",
        };
        _trGroup = {
          _id: {
            year: "$yr",
            month: "$mn",
            day: "$dt",
            hour: "$hour",
            minute: {
              $add: [
                {
                  $subtract: [
                    { $minute: "$modifiedDate" },
                    { $mod: [{ $minute: "$modifiedDate" }, +resol] },
                  ],
                },
              ],
            },
          },
          count: {
            $sum: 1,
          },
          Date: { $last: "$date" },
          pair: { $first: "$pair" },
          low: { $min: "$low" },
          high: { $max: "$high" },
          open: { $first: "$open" },
          close: { $last: "$close" },
          // volume: { $sum: "$tradeQty" },
        };
      }
    }
    const collection = `chart_${pairName}_${"1m"}`;
    const modal = mongoose.model(collection, ChartSchema, collection);

    let chartDoc = await modal.aggregate(
      [
        {
          $match: {
            pair: pairName,
            // date: {
            //   $gte: new Date(startDateTimestamp * 1000),
            //   $lte: new Date(endDateTimestamp * 1000),
            // },
          },
        },
        {
          $group: _trGroup,
        },
        {
          $project: project,
        },
        {
          $sort: {
            Date: 1,
          },
        },
      ],
      { allowDiskUse: true }
    );

    let getDoc = await hget(`chartHistory_${resol}`, pairName);
    if (getDoc) {
      getDoc = JSON.parse(getDoc);

      let doc = {
        Date: getDoc.date,
        pair: pairName,
        open: getDoc.open,
        close: getDoc.close,
        low: getDoc.low,
        high: getDoc.high,
        exchange: "Cryptodex",
      };

      getDoc = doc;
    }

    // console.log(getDoc, "getDocgetDocgetDocgetDoc")

    chartDoc = [...chartDoc, ...[getDoc]];

    return chartDoc;
  } catch (e) {
    console.log("e: ", e);
    return [];
  }
}

export const Old_chart = async ({ pairName, timeType, startDateTimestamp }) => {
  try {
    let pairList = getSymbol();
    if (pairList && pairList.length > 0) {
      let pairData = pairList.find((el) => el.name == pairName);

      if (pairData) {
        let getDoc = await hget(`chartHistory_${timeType}`, pairName);
        if (getDoc) {
          getDoc = JSON.parse(getDoc);
        }
        // console.log("-----getDoc", getDoc)
        const collection = `chart_${pairName}_${timeType}`;
        const modal = mongoose.model(collection, ChartSchema, collection);

        return {
          chartData: [...(await modal.find({})), ...[getDoc]],
          callBy: "spotTrade",
        };
      }
      return [];
    }
    return [];
  } catch (err) {
    console.log("err------chart------- ", err);
    return [];
  }
};

export const chart = async ({
  pairName,
  timeType,
  startDateTimestamp,
  endDateTimestamp,
}) => {
  try {
    let pairList = getSymbol();
    if (pairList && pairList.length > 0) {
      let pairData = pairList.find((el) => el.name == pairName);
      if (pairData) {
        if (pairData.botstatus == "bot") {
          return {
            chartData: await chartData({
              pairName,
              resol: timeType,
              startDateTimestamp,
              endDateTimestamp,
            }),
            callBy: "bot",
          };
        } else {
          // Convert pairName (e.g., "SOLUSD") to Binance format (e.g., "SOLUSDT")
          // replacePair only works on single currency symbols, so we need to split and handle
          let binancePairName = pairName;
          if (pairName.endsWith("USD")) {
            binancePairName = pairName.slice(0, -3) + "USDT";
          }

          const rawData = await nodeBinanceAPI.candlesticks(binancePairName, timeType);

          // Convert new Binance format (array of objects) to expected format (array of arrays)
          let chartData = [];
          if (Array.isArray(rawData)) {
            if (rawData.length > 0 && typeof rawData[0] === 'object') {
              // New format: array of objects {openTime, open, high, low, close, volume, ...}
              chartData = rawData.map(candle => [
                candle.openTime,
                candle.open,
                candle.high,
                candle.low,
                candle.close,
                candle.volume
              ]);
            } else if (rawData.length > 0 && Array.isArray(rawData[0])) {
              // Old format: array of arrays [time, open, high, low, close, volume]
              chartData = rawData;
            }
          }

          return {
            chartData: chartData,
            callBy: "binance",
          };
        }
      }
      return [];
    }
    return [];
  } catch (err) {
    console.log("err------chart------- ", err);
    return [];
  }
};

export const ChartDocHistory = async (orderData) => {
  updateChartIntvl({ ...orderData, interval: "1m" });
  updateChartIntvl({ ...orderData, interval: "5m" });
  updateChartIntvl({ ...orderData, interval: "15m" });
  updateChartIntvl({ ...orderData, interval: "30m" });
  updateChartIntvl({ ...orderData, interval: "1h" });
  updateChartIntvl({ ...orderData, interval: "4h" });
  updateChartIntvl({ ...orderData, interval: "1d" });
  updateChartIntvl({ ...orderData, interval: "1W" });
  updateChartIntvl({ ...orderData, interval: "1M" });
};

export const updateChartIntvl = async (orderData) => {
  try {
    const { price, pairName, interval } = orderData;
    let getDoc = await hget(`chartHistory_${interval}`, pairName);

    if (getDoc == null) {
      let doc = {
        date: new Date(),
        open: price,
        close: price,
        low: price,
        high: price,
      };
      hset(`chartHistory_${interval}`, pairName, doc);
    } else {
      getDoc = JSON.parse(getDoc);
      // getDoc.open = getDoc.open;
      getDoc.close = price;
      getDoc.low = getDoc.low > price ? price : getDoc.low;
      getDoc.high = getDoc.high > price ? getDoc.high : price;
      hset(`chartHistory_${interval}`, pairName, getDoc);
    }
  } catch (err) {
    console.log("err-------- ", err);
  }
};

//Dynamic Setup
export const updateDB = async (data) => {
  try {
    const { pair, interval } = data;
    let getDoc = await hget(`chartHistory_${interval}`, pair);
    if (!isEmpty(getDoc)) {
      getDoc = JSON.parse(getDoc);
      let doc = {
        date: getDoc.date,
        pair: pair,
        low: getDoc.low,
        high: getDoc.high,
        open: getDoc.open,
        close: getDoc.close,
      };

      const collection = `chart_${pair}_${interval}`;
      const modal = mongoose.model(collection, ChartSchema, collection);

      await modal.create(doc);

      let newDoc = JSON.parse(JSON.stringify(getDoc));
      newDoc.open = newDoc.close;
      newDoc.low = newDoc.close;
      newDoc.high = newDoc.close;
      newDoc.date = new Date();
      hset(`chartHistory_${interval}`, pair, newDoc);
    }
  } catch (err) {
    console.log("err", err);
  }
};

export const redisToDB = async (interval) => {
  try {
    let spotPairDoc = await hgetall("spotPairdata");
    if (spotPairDoc) {
      spotPairDoc = await getActivePairs(spotPairDoc);
    }

    if (spotPairDoc && spotPairDoc.length > 0) {
      for (let pairItem of spotPairDoc) {
        updateDB({
          pair: pairItem.tikerRoot,
          interval,
        });
      }
    }
  } catch (err) {
    console.log(err, "Errr chart history");
  }
};

function differenceMin(date1, date2) {
  const startTime = new Date(date1);
  const endTime = new Date(date2);
  var difference = endTime.getTime() - startTime.getTime(); // This will give difference in milliseconds
  var resultInMinutes = Math.round(difference / 60000);
  return resultInMinutes;
}

// function generateTimestamps(startDate, endDate) {
//   const timestamps = [];
//   let currentTimestamp = new Date(startDate);

//   while (currentTimestamp <= endDate) {
//     timestamps.push(new Date(currentTimestamp));
//     currentTimestamp.setMinutes(currentTimestamp.getMinutes() + 1);
//   }

//   return timestamps;
// }

function generateTimestamps(startDate, endDate, timeinterval) {
  const timestamps = [];
  const interval = timeinterval * 60 * 1000; // 5 minutes in milliseconds

  let currentTimestamp = startDate.getTime();

  while (currentTimestamp <= endDate.getTime()) {
    timestamps.push(new Date(currentTimestamp));
    currentTimestamp += interval;
  }

  return timestamps;
}

/* 
  Trade History To Dynamic Db and redis 
*/

export const getFromQuery = async (pairName) => {
  try {
    let project = {
      Date: "$Date",
      pair: "$pair",
      low: "$low",
      high: "$high",
      open: "$open",
      close: "$close",
      volume: "$volume",
      exchange: "Cryptodex",
    };

    //check 1 min
    let _trGroup = {
      _id: {
        year: {
          $year: "$createdAt",
        },
        month: {
          $month: "$createdAt",
        },
        day: {
          $dayOfMonth: "$createdAt",
        },
        hour: { $hour: "$createdAt" },
        minute: { $minute: "$createdAt" },
      },
      Date: { $last: "$createdAt" },
      pair: { $first: "$pairName" },
      low: { $min: "$tradePrice" },
      high: { $max: "$tradePrice" },
      open: { $first: "$tradePrice" },
      close: { $last: "$tradePrice" },
      volume: { $sum: "$tradeQty" },
    };

    let chartDoc = await TradeHistory.aggregate([
      {
        $match: {
          pairName: pairName,
          status: "completed",
        },
      },
      {
        $group: _trGroup,
      },
      {
        $project: project,
      },
      {
        $sort: {
          Date: 1,
        },
      },
    ]);
    return chartDoc;
  } catch (err) {
    console.log(err, "errerrerrerrerrerr111");
  }
};

export const Old_UpdateTradeToDB = async (data) => {
  try {
    let spotPairDoc = await SpotPair.find({ status: "active" }).lean();

    if (spotPairDoc && spotPairDoc.length > 0) {
      for (let pairItem of spotPairDoc) {
        let chartData = await getFromQuery(pairItem.tikerRoot);
        let pairName = pairItem.tikerRoot;
        let ChartDoc = [];
        let length = chartData.length;
        if (chartData && length > 0) {
          for (let i = 0; i < length - 1; i++) {
            let curData = chartData[i];
            let nextData = chartData[i + 1];

            let getDifferMins = differenceMin(curData.Date, nextData.Date);

            if (getDifferMins == 1 || getDifferMins < 1) {
              continue;
            } else if (getDifferMins > 1) {
              let timestamps = generateTimestamps(
                new Date(curData.Date),
                new Date(nextData.Date)
              );
              timestamps.pop();
              let timelength = timestamps.length;
              if (timelength > 0) {
                Array.from({ length: timelength - 1 }, (_, index) => {
                  // console.log('-----', index)
                  let doc = {
                    date: timestamps[index],
                    pair: curData.pair,
                    low: curData.low,
                    high: curData.high,
                    open: curData.open,
                    close: curData.close,
                  };
                  ChartDoc.push(doc);
                });
              }
            }
          }
          let interval = "1m";
          const collection = `chart_${pairName}_${interval}`;
          const modal = mongoose.model(collection, ChartSchema, collection);

          const batchSize = 1000; // Number of documents to insert in each batch

          async function insertData(data) {
            for (let i = 0; i < data.length; i += batchSize) {
              const batch = data.slice(i, i + batchSize);
              await modal.insertMany(batch);
            }
          }

          await insertData(ChartDoc);
        }
      }
    }
  } catch (err) {
    console.log(err, "Err on UpdateTradeToDB");
  }
};

export const UpdateTradeToDB = async (pairName, resol) => {
  try {
    if (pairName && resol) {
      let getChartData = await Old_chartData({ pairName, resol });
      let ChartDoc = [];

      let length = getChartData.length;
      if (getChartData && length > 0) {
        for (let i = 0; i < length - 1; i++) {
          let curData = getChartData[i];
          let nextData = getChartData[i + 1];

          let getDifferMins = differenceMin(curData.Date, nextData.Date);

          let timeInterval = 1;
          if (resol == "1m") {
            getDifferMins = getDifferMins / 1;
            timeInterval = 1;
          } else if (resol == "2m") {
            getDifferMins = getDifferMins / 2;
            timeInterval = 2;
          } else if (resol == "5m") {
            getDifferMins = getDifferMins / 5;
            timeInterval = 5;
          } else if (resol == "15m") {
            getDifferMins = getDifferMins / 15;
            timeInterval = 15;
          } else if (resol == "30m") {
            getDifferMins = getDifferMins / 30;
            timeInterval = 30;
          } else if (resol == "1h") {
            getDifferMins = getDifferMins / 60;
            timeInterval = 60;
          } else if (resol == "4h") {
            getDifferMins = getDifferMins / 240;
            timeInterval = 240;
          } else if (resol == "1d") {
            getDifferMins = getDifferMins / 1440;
            timeInterval = 1440;
          } else if (resol == "1W") {
            getDifferMins = getDifferMins / 10080;
            timeInterval = 10080;
          } else if (resol == "1M") {
            getDifferMins = getDifferMins / 43800;
            timeInterval = 43800;
          }

          getDifferMins = Math.round(getDifferMins);

          if (getDifferMins == 1 || getDifferMins < 1) {
            continue;
          } else if (getDifferMins > 1) {
            let timestamps = generateTimestamps(
              new Date(curData.Date),
              new Date(nextData.Date),
              timeInterval
            );
            timestamps.pop();
            let timelength = timestamps.length;
            if (timelength > 0) {
              Array.from({ length: timelength - 1 }, (_, index) => {
                let doc = {
                  date: timestamps[index],
                  pair: curData.pair,
                  low: curData.low,
                  high: curData.high,
                  open: curData.open,
                  close: curData.close,
                };
                ChartDoc.push(doc);
              });
            }
          }
        }
        const collection = `chart_${pairName}_${resol}`;
        const modal = mongoose.model(collection, ChartSchema, collection);

        const batchSize = 1000; // Number of documents to insert in each batch

        async function insertData(data) {
          for (let i = 0; i < data.length; i += batchSize) {
            const batch = data.slice(i, i + batchSize);
            await modal.insertMany(batch);
          }
        }
        await insertData(ChartDoc);
      }
    }
  } catch (err) {
    console.log(err, "Err on UpdateTradeToDB");
  }
};

export const AllPairUpdate = async () => {
  let spotPairDoc = await SpotPair.find({ status: "active" }).lean();
  let resolution = ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1W", "1M"];
  if (spotPairDoc && spotPairDoc.length > 0) {
    for (let pairItem of spotPairDoc) {
      for (let resol of resolution) {
        UpdateTradeToDB(pairItem.tikerRoot, resol);
      }
    }
  }
};

//first call api AllPairUpdate for all pair db update new

export const AllPairDbToRedis = async () => {
  try {
    let spotPairDoc = await SpotPair.find({ status: "active" }).lean();
    let resol = ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1W", "1M"];
    if (spotPairDoc && spotPairDoc.length > 0) {
      for (let pairItem of spotPairDoc) {
        for (let resol of resol) {
          updateDBToRedis(pairItem.tikerRoot, resol);
        }
      }
    }
  } catch (err) {
    console.log(err, "Err on AllPairDbToRedis");
  }
};

//second call api AllPairDbToRedis for all pair redis update new

export const updateDBToRedis = async (pairName, resol) => {
  try {
    const collection = `chart_${pairName}_${resol}`;
    const model = mongoose.model(collection, ChartSchema, collection);
    let getTradeData = await model.findOne({}, {}, { sort: { date: -1 } });
    if (getTradeData == null) {
      return;
    }

    let getDoc = await hget(`chartHistory_${resol}`, pairName);

    if (getDoc == null) {
      let doc = {
        date: new Date(),
        open: getTradeData.close,
        close: getTradeData.close,
        low: getTradeData.close,
        high: getTradeData.close,
      };
      hset(`chartHistory_${resol}`, pairName, doc);
    } else {
      getDoc = JSON.parse(getDoc);
      getDoc.close =
        getTradeData.close != null ? getTradeData.close : getDoc.close;
      getDoc.low =
        getTradeData.close != null && getDoc.low > getTradeData.close
          ? getTradeData.close
          : getDoc.low;
      getDoc.high =
        getTradeData.close != null && getDoc.high > getTradeData.close
          ? getDoc.high
          : getTradeData.close;

      hset(`chartHistory_${resol}`, pairName, getDoc);
    }
  } catch (err) {
    console.log(err, "Err on AllPairDbToRedis");
  }
};
