/*
  This file is a node.js module.

  This is a sample implementation of UDF-compatible datafeed wrapper for (historical data) and (quotes).
  Some algorithms may be incorrect because it's rather an UDF implementation sample
  then a proper datafeed implementation.
*/

/* global require */
/* global console */
/* global exports */
/* global process */
import { chart } from "../chart/chart.controller.js";
// import package
import moment from "moment";
import https from "https";
import http from "http";

("use strict");

var version = "2.0.2";
// REMOVED, both lines, and neither belonged in a running service:
//
//   process.env.ABCD_API_KEY = "<hardcoded key>";
//   process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
//
// The second is the serious one. Setting it at module scope disables TLS
// certificate verification for the ENTIRE PROCESS, permanently -- every HTTPS
// call spotapi makes afterwards, including the Binance market-data feed the
// whole venue depends on, would accept any certificate from any host. It is
// not scoped to a request and cannot be undone by a later caller.
//
// It served nothing here. This file is TradingView's UDF datafeed SAMPLE (see
// the header: "a sample implementation ... Some algorithms may be incorrect")
// and it makes no outbound requests at all -- there is not one http:// or
// https:// URL in it. The venue's chart data comes from
// `nodeBinanceAPI.candlesticks` in chart.controller.js, over a connection with
// a valid certificate. Verified by removing both lines and confirming
// GET /api/spot/chart/:config still returns real bars.
//
// The API-key line IS restored below, but only because module scope reads it
// unconditionally (`process.env.ABCD_API_KEY.split(",")`) and removing it threw
// a TypeError that killed the service on boot. It is inert -- the code behind it
// makes no requests -- and it is left as an empty default rather than the
// hardcoded credential that used to be here.
process.env.ABCD_API_KEY = process.env.ABCD_API_KEY || "";
var abcdCache = {};

let abcdCacheCleanupTime = 3 * 60 * 60 * 1000; // 3 hours
let abcdKeysValidateTime = 15 * 60 * 1000; // 15 minutes
let yahooFailedStateCacheTime = 3 * 60 * 60 * 1000; // 3 hours;
let abcdMinimumDate = "1970-01-01";

// this cache is intended to reduce number of requests to abcd
setInterval(function () {
  abcdCache = {};
}, abcdCacheCleanupTime);

function dateForLogs() {
  return new Date().toISOString() + ": ";
}

var defaultResponseHeader = {
  "Content-Type": "text/plain",
  "Access-Control-Allow-Origin": "*",
};

function sendJsonResponse(response, jsonData) {
  response.writeHead(200, defaultResponseHeader);
  response.write(JSON.stringify(jsonData));
  response.end();
}

function dateToYMD(date) {
  let obj = new Date(date);
  let year = obj.getFullYear();
  let m = obj.getMonth() + 1;
  let month = m < 10 ? "0" + m : m;
  let d = obj.getDate();
  let day = d < 10 ? "0" + d : d;
  return year + "-" + month + "-" + day;
}

var abcdKeys = process.env.ABCD_API_KEY.split(","); // you should create a free account on abcd.com to get this key, you can set some keys concatenated with a comma
var invalidabcdKeys = [];

function getValidabcdKey() {
  for (let i = 0; i < abcdKeys.length; i++) {
    let key = abcdKeys[i];
    if (invalidabcdKeys.indexOf(key) === -1) {
      return key;
    }
  }
  return null;
}

function markabcdKeyAsInvalid(key) {
  if (invalidabcdKeys.indexOf(key) !== -1) {
    return;
  }

  invalidabcdKeys.push(key);

  setTimeout(function () { }, abcdKeysValidateTime);
}

function sendError(error, response) {
  response.writeHead(200, defaultResponseHeader);
  response.write('{"s":"error","errmsg":"' + error + '"}');
  response.end();
}

function httpGet(datafeedHost, path, callback) {
  var options = {
    host: datafeedHost,
    path: path,
    port: "5000",
    method: "GET",
    headers: {
      "Content-Type": "application/json",
    },
    strictSSL: false,
  };

  function onDataCallback(response) {
    var result = "";
    response.on("data", function (chunk) {
      result += chunk;
    });

    response.on("end", function () {
      if (response.statusCode !== 200) {
        callback({
          status: "ERR_STATUS_CODE",
          errmsg: response.statusMessage || "",
        });
        return;
      }

      callback({
        status: "ok",
        data: result,
      });
    });
  }

  var req = http.request(options, onDataCallback);

  req.on("socket", function (socket) {
    socket.setTimeout(15000);
    socket.on("timeout", function () {
      req.abort();
    });
  });

  req.on("error", function (e) {
    callback({
      status: "ERR_SOCKET",
      errmsg: e.message || "",
    });
  });

  req.end();
}

function convertabcdHistoryToUDFFormat(data, callBy, tradeType) {
  function parseDate(input) {
    var parts = input.split("-");
    return Date.UTC(parts[0], parts[1] - 1, parts[2]);
  }

  function parseDated(input, timesx) {
    var parts = input.split("-");
    var times = timesx.split(":");
    return Date.UTC(
      parts[0],
      parts[1] - 1,
      parts[2],
      times[0],
      times[1],
      times[2],
      times[3]
    );
  }

  function formatDate(dateInput) {
    var datex = new Date(dateInput);
    var date = dateInput.split("-");
    // var finaltimex = datex.getHours() + ":" + datex.getMinutes() + ":" + datex.getSeconds() + ":" + datex.getMilliseconds();
    var finaltimex =
      datex.getUTCHours() +
      ":" +
      datex.getUTCMinutes() +
      ":" +
      datex.getUTCSeconds() +
      ":" +
      datex.getUTCMilliseconds();

    return {
      datex: date[0] + "-" + date[1] + "-" + date[2].substring(0, 2),
      timex: finaltimex,
    };
  }

  function columnIndices(columns) {
    var indices = {};
    for (var i = 0; i < columns.length; i++) {
      indices[columns[i].name] = i;
    }

    return indices;
  }

  var result = {
    t: [],
    c: [],
    o: [],
    h: [],
    l: [],
    v: [],
    s: "ok",
  };

  try {
    var json = JSON.parse(data);

    json.forEach(function (row, index, array) {
      // console.log(callBy, '------204', row)
      if (callBy == "bot") {
        var formatDatex = formatDate(row.Date);
        var fi = dateToYMD(formatDatex.datex);
        result.t.push(parseDated(fi, formatDatex.timex) / 1000);
        result.o.push(row.open);
        result.h.push(row.high);
        result.l.push(row.low);
        result.c.push(row.close);
        result.v.push(row.volume);

      } else {
        // if (callBy == "binance") {
        let [time, open, high, low, close, volume] = row;

        var formatDatex = formatDate(new Date(time).toISOString());
        var fi = dateToYMD(formatDatex.datex);
        result.t.push(parseDated(fi, formatDatex.timex) / 1000);
        result.o.push(open);
        result.h.push(high);
        result.l.push(low);
        result.c.push(close);
        result.v.push(volume);
      }
      //   let { time, open, high, low, close, volume } = row;

      //   var formatDatex = formatDate(new Date(time).toISOString());
      //   var fi = dateToYMD(formatDatex.datex);
      //   result.t.push(parseDated(fi, formatDatex.timex) / 1000);
      //   result.o.push(open);
      //   result.h.push(high);
      //   result.l.push(low);
      //   result.c.push(close);
      //   result.v.push(volume);
      //   let { open_time, open, high, low, close, volume } = row;
      //   var formatDatex = formatDate(new Date(open_time * 1000).toISOString());
      //   var fi = dateToYMD(formatDatex.datex);
      //   result.t.push(parseDated(fi, formatDatex.timex) / 1000);
      //   result.o.push(open);
      //   result.h.push(high);
      //   result.l.push(low);
      //   result.c.push(close);
      //   result.v.push(volume);
      // } else {
      //   var formatDatex = formatDate(row.Date);
      //   var fi = dateToYMD(formatDatex.datex);
      //   result.t.push(parseDated(fi, formatDatex.timex) / 1000);
      //   result.o.push(row.open);
      //   result.h.push(row.high);
      //   result.l.push(row.low);
      //   result.c.push(row.close);
      //   result.v.push(row.volume);
      // }
    });
  } catch (error) {
    console.log("error: ", error);
    return null;
  }

  return result;
}

function convertYahooQuotesToUDFFormat(tickersMap, data) {
  if (!data.query || !data.query.results) {
    var errmsg = "ERROR: empty quotes response: " + JSON.stringify(data);

    return {
      s: "error",
      errmsg: errmsg,
    };
  }

  var result = {
    s: "ok",
    d: [],
  };

  [].concat(data.query.results.quote).forEach(function (quote) {
    var ticker = tickersMap[quote.symbol];

    // this field is an error token
    if (
      quote["ErrorIndicationreturnedforsymbolchangedinvalid"] ||
      !quote.StockExchange
    ) {
      result.d.push({
        s: "error",
        n: ticker,
        v: {},
      });
      return;
    }

    result.d.push({
      s: "ok",
      n: ticker,
      v: {
        ch: +(quote.ChangeRealtime || quote.Change),
        chp: +(
          (quote.PercentChange || quote.ChangeinPercent) &&
          (quote.PercentChange || quote.ChangeinPercent).replace(
            /[+-]?(.*)%/,
            "$1"
          )
        ),

        short_name: quote.Symbol,
        exchange: quote.StockExchange,
        original_name: quote.StockExchange + ":" + quote.Symbol,
        description: quote.Name,

        lp: +quote.LastTradePriceOnly,
        ask: +quote.AskRealtime,
        bid: +quote.BidRealtime,

        open_price: +quote.Open,
        high_price: +quote.DaysHigh,
        low_price: +quote.DaysLow,
        prev_close_price: +quote.PreviousClose,
        volume: +quote.Volume,
      },
    });
  });
  return result;
}

function proxyRequest(controller, options, response) {
  controller
    .request(options, function (res) {
      var result = "";

      res.on("data", function (chunk) {
        result += chunk;
      });

      res.on("end", function () {
        if (res.statusCode !== 200) {
          response.writeHead(200, defaultResponseHeader);
          response.write(
            JSON.stringify({
              s: "error",
              errmsg: "Failed to get news",
            })
          );
          response.end();
          return;
        }
        response.writeHead(200, defaultResponseHeader);
        response.write(result);
        response.end();
      });
    })
    .end();
}

function RequestProcessor(symbolsDatabase) {
  this._symbolsDatabase = symbolsDatabase;
  this._failedYahooTime = {};
}

function toTimestamp(strDate) {
  var datum = Date.parse(strDate);
  return datum / 1000;
}

function getMinutes(prev, current) {
  var prev = new Date(prev * 1000);
  var current = new Date(current * 1000);
  var diff = Math.abs(current - prev);
  var minutes = Math.floor(diff / 1000 / 60);
  return minutes;
}

function filterDataPeriod(data, fromSeconds, toSeconds) {
  if (!data || !data.t) {
    return data;
  }

  if (data.t[data.t.length - 1] < fromSeconds) {
    return {
      s: "no_data",
      nextTime: data.t[data.t.length - 1],
    };
  }

  // if (data.t[data.t.length - 1] < fromSeconds) {

  //   let fromData = {
  //     t: [],
  //     o: [],
  //     h: [],
  //     l: [],
  //     c: [],
  //     v: [],
  //     s: data.s
  //   }

  //   let time = data.t[0];

  //   // for (let i = 1; i <= data.t.length - 1; i++) {
  //   //   let getMin = getMinutes(time, data.t[i])
  //   //   console.log(getMin, "getMingetMingetMingetMin")
  //   // }

  //   for (let i = 1; i <= data.t.length - 1; i++) {
  //     console.log(time, data.t[i])
  //     let getMin = getMinutes(time, data.t[i])
  //     console.log(getMin, "getMingetMingetMingetMin")
  //     if (getMin == 1) {
  //       fromData.t.push(data.t[i]);
  //       fromData.o.push(data.o[i]);
  //       fromData.h.push(data.h[i]);
  //       fromData.l.push(data.l[i]);
  //       fromData.c.push(data.c[i]);
  //       fromData.v.push(data.v[i]);

  //       time = data.t[i]
  //       continue;
  //     }
  //     Array.from({ length: getMin }, (_, index) => {
  //       fromData.t.push(data.t[i]);
  //       fromData.o.push(data.o[i]);
  //       fromData.h.push(data.h[i]);
  //       fromData.l.push(data.l[i]);
  //       fromData.c.push(data.c[i]);
  //       fromData.v.push(data.v[i]);
  //     })

  //     time = data.t[i]
  //   }

  //   if (fromData) {
  //     return {
  //       t: fromData.t,
  //       o: fromData.o,
  //       h: fromData.h,
  //       l: fromData.l,
  //       c: fromData.c,
  //       v: fromData.v,
  //       s: fromData.s,
  //     }
  //   }

  //   return {
  //     s: "no_data",
  //     nextTime: data.t[data.t.length - 1],
  //   };
  // }

  var fromIndex = null;
  var toIndex = null;
  var times = data.t;
  for (var i = 0; i < times.length; i++) {
    var time = times[i];
    if (fromIndex === null && time >= fromSeconds) {
      fromIndex = i;
    }
    if (toIndex === null && time >= toSeconds) {
      toIndex = time > toSeconds ? i - 1 : i;
    }
    if (fromIndex !== null && toIndex !== null) {
      break;
    }
  }

  fromIndex = fromIndex || 0;
  toIndex = toIndex ? toIndex + 1 : times.length;

  var s = data.s;

  if (toSeconds < times[0]) {
    s = "no_data";
  }

  toIndex = Math.min(fromIndex + 1000, toIndex); // do not send more than 1000 bars for server capacity reasons

  return {
    t: data.t,
    o: data.o,
    h: data.h,
    l: data.l,
    c: data.c,
    v: data.v,
    s: s,
  };
}

RequestProcessor.prototype._sendConfig = function (response) {
  var config = {
    supports_search: true,
    supports_group_request: false,
    supports_marks: true,
    supports_timescale_marks: true,
    supports_time: true,
    exchanges: [
      {
        value: "",
        name: "All Exchanges",
        desc: "",
      },
      {
        value: "Cryptodex",
        name: "Cryptodex",
        desc: "Cryptodex",
      },
    ],
    symbols_types: [
      {
        name: "All types",
        value: "",
      },
      {
        name: "Cryptocurrency",
        value: "crypto",
      },
    ],
    supported_resolutions: ["1", "5", "15", "30", "60", "1D", "1W", "1M"],
  };

  response.writeHead(200, defaultResponseHeader);
  response.write(JSON.stringify(config));
  response.end();
};

RequestProcessor.prototype._sendMarks = function (response) {
  var now = new Date();
  now =
    new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    ) / 1000;
  var day = 60 * 60 * 24;

  var marks = {
    id: [0, 1, 2, 3, 4, 5],
    time: [
      now,
      now - day * 4,
      now - day * 7,
      now - day * 7,
      now - day * 15,
      now - day * 30,
    ],
    color: ["red", "blue", "green", "red", "blue", "green"],
    text: [
      "Today",
      "4 days back",
      "7 days back + Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.",
      "7 days back once again",
      "15 days back",
      "30 days back",
    ],
    label: ["A", "B", "CORE", "D", "EURO", "F"],
    labelFontColor: ["white", "white", "red", "#FFFFFF", "white", "#000"],
    minSize: [14, 28, 7, 40, 7, 14],
  };

  response.writeHead(200, defaultResponseHeader);
  response.write(JSON.stringify(marks));
  response.end();
};

RequestProcessor.prototype._sendTime = function (response) {
  var now = new Date();
  response.writeHead(200, defaultResponseHeader);
  response.write(Math.floor(now / 1000) + "");
  response.end();
};

RequestProcessor.prototype._sendTimescaleMarks = function (response) {
  var now = new Date();
  now =
    new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    ) / 1000;
  var day = 60 * 60 * 24;

  var marks = [
    {
      id: "tsm1",
      time: now,
      color: "red",
      label: "A",
      tooltip: "",
    },
    {
      id: "tsm2",
      time: now - day * 4,
      color: "blue",
      label: "D",
      tooltip: [
        "Dividends: $0.56",
        "Date: " + new Date((now - day * 4) * 1000).toDateString(),
      ],
    },
    {
      id: "tsm3",
      time: now - day * 7,
      color: "green",
      label: "D",
      tooltip: [
        "Dividends: $3.46",
        "Date: " + new Date((now - day * 7) * 1000).toDateString(),
      ],
    },
    {
      id: "tsm4",
      time: now - day * 15,
      color: "#999999",
      label: "E",
      tooltip: ["Earnings: $3.44", "Estimate: $3.60"],
    },
    {
      id: "tsm7",
      time: now - day * 30,
      color: "red",
      label: "E",
      tooltip: ["Earnings: $5.40", "Estimate: $5.00"],
    },
  ];

  response.writeHead(200, defaultResponseHeader);
  response.write(JSON.stringify(marks));
  response.end();
};

RequestProcessor.prototype._sendSymbolSearchResults = function (
  query,
  type,
  exchange,
  maxRecords,
  response
) {
  if (!maxRecords) {
    throw "wrong_query";
  }

  var result = this._symbolsDatabase.search(query, type, exchange, maxRecords);

  response.writeHead(200, defaultResponseHeader);
  response.write(JSON.stringify(result));
  response.end();
};

RequestProcessor.prototype._prepareSymbolInfo = async function (
  symbolName,
  tradeType
) {
  var symbolInfo = this._symbolsDatabase.symbolInfo(symbolName, tradeType);

  if (!symbolInfo) {
    throw new Error("unknown_symbol " + symbolName);
  }

  // Calculate pricescale based on trading pair precision
  // Fetch the pair data to get secondFloatDigit (price precision)
  let pricePrecision = 2; // default
  let volumePrecision = 8; // default

  if (tradeType === "spot") {
    try {
      const { SpotPair } = await import("../../models/index.js");
      const pairName = symbolName.toUpperCase();
      const pairData = await SpotPair.findOne({
        $or: [
          { tikerRoot: pairName },
          {
            $expr: {
              $eq: [
                { $concat: ["$firstCurrencySymbol", "$secondCurrencySymbol"] },
                pairName
              ]
            }
          }
        ]
      }).lean();

      if (pairData) {
        pricePrecision = pairData.secondFloatDigit || 2;
        volumePrecision = pairData.firstFloatDigit || 8;
      }
    } catch (err) {
      console.log("Error fetching pair precision:", err);
    }
  }

  // pricescale = 10^precision, so 2 decimals = 100, 1 decimal = 10, etc.
  const pricescale = Math.pow(10, pricePrecision);

  return {
    name: symbolInfo.name,
    "exchange-traded": symbolInfo.exchange,
    "exchange-listed": symbolInfo.exchange,
    timezone: "America/New_York",
    minmov: 1,
    minmov2: 0,
    pointvalue: 1,
    session: "0930-1630",
    has_intraday: true,
    has_empty_bars: false,
    has_no_volume: true /* symbolInfo.type !== "stock" */,
    indicators: "SMA",
    description:
      symbolInfo.description.length > 0
        ? symbolInfo.description
        : symbolInfo.name,
    type: symbolInfo.type,
    supported_resolutions: ["1", "5", "15", "30", "60", "1D", "1W", "1M"],
    pricescale: pricescale,
    ticker: symbolInfo.name.toUpperCase(),
  };
};

RequestProcessor.prototype._sendSymbolInfo = async function (
  symbolName,
  response,
  tradeType
) {
  var info = await this._prepareSymbolInfo(symbolName, tradeType);

  response.writeHead(200, defaultResponseHeader);
  response.write(JSON.stringify(info));
  response.end();
};

RequestProcessor.prototype._sendSymbolHistory = async function (
  symbol,
  startDateTimestamp,
  endDateTimestamp,
  resolution,
  response,
  tradeType
) {
  try {
    function sendResult(content) {
      var header = Object.assign({}, defaultResponseHeader);
      header["Content-Length"] = content.length;
      response.writeHead(200, header);
      response.write(content, null, function () {
        response.end();
      });
    }

    function secondsToISO(sec) {
      if (sec === null || sec === undefined) {
        return "n/a";
      }
      return new Date(sec * 1000).toISOString();
    }

    function logForData(data, _key, _isCached) {
      var fromCacheTime = data && data.t ? data.t[0] : null;
      var toCacheTime = data && data.t ? data.t[data.t.length - 1] : null;
    }

    function resolutionType(type) {
      switch (type) {
        case "1":
          return "1m";
        case "5":
          return "5m";
        case "15":
          return "15m";
        case "30":
          return "30m";
        case "60":
          return "1h";
        case "1d":
          return "1d";
        case "d":
          return "1M";
        default:
          return "1m";
      }
    }

    // always request all data to reduce number of requests to abcd
    var from = abcdMinimumDate;
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    var to = dateToYMD(tomorrow);

    var key = symbol + "|" + from + "|" + to;

    var abcdKey = getValidabcdKey();

    if (abcdKey === null) {
      sendError("No valid API Keys available", response);
      return;
    }

    let pair = symbol;
    let start_date = from;
    let end_date = to;
    let resol = resolution;
    let spl = pair.split("_");
    let first = spl[0];
    let second = spl[1];
    let pattern = /^([0-9]{4})\-([0-9]{2})\-([0-9]{2})$/;
    let _trProject;
    let _trGroup;
    let _exProject;
    let _exGroup;
    if (start_date) {
      if (!pattern.test(start_date)) {
        res.json({ message: "Start date is not a valid format" });
        return false;
      }
    } else {
      res.json({ message: "Start date parameter not found" });
      return false;
    }
    if (end_date) {
      if (!pattern.test(end_date)) {
        res.json({ message: "End date is not a valid format" });
        return false;
      }
    } else {
      res.json({ message: "End date parameter not found" });
      return false;
    }

    let timeType = resolutionType(resol);

    let tradeChart;

    if (tradeType == "spot") {
      tradeChart = await chart({
        pairName: pair,
        timeType,
        startDateTimestamp,
        endDateTimestamp,
      });
    }

    if (tradeChart && tradeChart.chartData && tradeChart.chartData.length > 0) {
      let data = convertabcdHistoryToUDFFormat(
        JSON.stringify(tradeChart.chartData),
        tradeChart.callBy,
        tradeType
      );
      if (data === null) {
        sendError("Invalid abcd response", response);
        return;
      }
      let filteredData = filterDataPeriod(
        data,
        startDateTimestamp,
        endDateTimestamp
      );
      logForData(filteredData, key, false);
      sendResult(JSON.stringify(filteredData));
    } else {
      console.log("xxxxxxxxxxxxxxxnullxxxxxxxxxxxxxxxxxxx");
      // Send empty response instead of hanging
      sendError("No chart data available for this symbol", response);
    }
  } catch (err) {
    console.log("---------------------------chart err", err);
    sendError("Chart error: " + err.message, response);
  }
};

RequestProcessor.prototype._quotesabcdWorkaround = function (tickersMap) {
  let from = abcdMinimumDate;
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  let to = dateToYMD(tomorrow);

  let result = {
    s: "ok",
    d: [],
    source: "abcd",
  };

  Object.keys(tickersMap).forEach(function (symbol) {
    let key = symbol + "|" + from + "|" + to;
    let ticker = tickersMap[symbol];

    let data = abcdCache[key];
    let length = data === undefined ? 0 : data.c.length;

    if (length > 0) {
      let lastBar = {
        o: data.o[length - 1],
        h: data.o[length - 1],
        l: data.o[length - 1],
        c: data.o[length - 1],
        v: data.o[length - 1],
      };

      result.d.push({
        s: "ok",
        n: ticker,
        v: {
          ch: 0,
          chp: 0,

          short_name: symbol,
          exchange: "",
          original_name: ticker,
          description: ticker,

          lp: lastBar.c,
          ask: lastBar.c,
          bid: lastBar.c,

          open_price: lastBar.o,
          high_price: lastBar.h,
          low_price: lastBar.l,
          prev_close_price: length > 1 ? data.c[length - 2] : lastBar.o,
          volume: lastBar.v,
        },
      });
    }
  });

  return result;
};

RequestProcessor.prototype._sendQuotes = function (tickersString, response) {
  let tickersMap = {}; // maps YQL symbol to ticker

  let tickers = tickersString.split(",");
  [].concat(tickers).forEach(function (ticker) {
    var yqlSymbol = ticker.replace(/.*:(.*)/, "$1");
    tickersMap[yqlSymbol] = ticker;
  });

  if (
    this._failedYahooTime[tickersString] &&
    Date.now() - this._failedYahooTime[tickersString] <
    yahooFailedStateCacheTime
  ) {
    sendJsonResponse(response, this._quotesabcdWorkaround(tickersMap));
    return;
  }

  let that = this;

  let yql =
    "env 'store://datatables.org/alltableswithkeys'; select * from yahoo.finance.quotes where symbol in ('" +
    Object.keys(tickersMap).join("','") +
    "')";

  let options = {
    host: "query.yahooapis.com",
    path:
      "/v1/public/yql?q=" +
      encodeURIComponent(yql) +
      "&format=json" +
      "&env=store://datatables.org/alltableswithkeys",
  };
  // for debug purposes

  http
    .request(options, function (res) {
      let result = "";

      res.on("data", function (chunk) {
        result += chunk;
      });

      res.on("end", function () {
        let jsonResponse = {
          s: "error",
        };

        if (res.statusCode === 200) {
          jsonResponse = convertYahooQuotesToUDFFormat(
            tickersMap,
            JSON.parse(result)
          );
        } else {
          console.error("Yahoo Fails with code " + res.statusCode);
        }

        if (jsonResponse.s === "error") {
          that._failedYahooTime[tickersString] = Date.now();
          jsonResponse = that._quotesabcdWorkaround(tickersMap);
        }

        sendJsonResponse(response, jsonResponse);
      });
    })
    .end();
};

RequestProcessor.prototype._sendNews = function (symbol, response) {
  let options = {
    host: "feeds.finance.yahoo.com",
    path: "/rss/2.0/headline?s=" + symbol + "&region=US&lang=en-US",
  };

  proxyRequest(http, options, response);
};

RequestProcessor.prototype._sendFuturesmag = function (response) {
  let options = {
    host: "www.futuresmag.com",
    path: "/rss/all",
  };

  proxyRequest(http, options, response);
};

RequestProcessor.prototype.processRequest = async function (
  action,
  query,
  response,
  tradeType,
  pairId
) {
  try {
    if (action === "/config") {
      this._sendConfig(response);
    } else if (action === "/symbols" && !!query["symbol"]) {
      await this._sendSymbolInfo(query["symbol"], response, tradeType);
    } else if (action === "/search") {
      this._sendSymbolSearchResults(
        query["query"],
        query["type"],
        query["exchange"],
        query["limit"],
        response
      );
    } else if (action === "/history") {
      this._sendSymbolHistory(
        query["symbol"],
        query["from"],
        query["to"],
        query["resolution"].toLowerCase(),
        response,
        tradeType,
        pairId
      );
    } else if (action === "/quotes") {
      this._sendQuotes(query["symbols"], response);
    } else if (action === "/marks") {
      this._sendMarks(response);
    } else if (action === "/time") {
      this._sendTime(response);
    } else if (action === "/timescale_marks") {
      this._sendTimescaleMarks(response);
    } else if (action === "/news") {
      this._sendNews(query["symbol"], response);
    } else if (action === "/futuresmag") {
      this._sendFuturesmag(response);
    } else {
      response.writeHead(200, defaultResponseHeader);
      response.write(
        "Datafeed version is " +
        version +
        "\nValid keys count is " +
        String(abcdKeys.length - invalidabcdKeys.length) +
        "\nCurrent key is " +
        (getValidabcdKey() || "").slice(0, 3) +
        (invalidabcdKeys.length !== 0
          ? "\nInvalid keys are " +
          invalidabcdKeys.reduce(function (prev, cur) {
            return prev + cur.slice(0, 3) + ",";
          }, "")
          : "")
      );
      response.end();
    }
  } catch (err) {
    // A bad datafeed query (unknown symbol, missing resolution, ...) must answer
    // with the UDF error payload, never reject and take the process down.
    const errmsg = (err && err.message) || String(err);
    console.log(dateForLogs() + "Chart request failed: " + errmsg);
    if (!response.headersSent) {
      response.writeHead(200, defaultResponseHeader);
      response.write(JSON.stringify({ s: "error", errmsg: errmsg }));
      response.end();
    }
  }
};

export { RequestProcessor };
