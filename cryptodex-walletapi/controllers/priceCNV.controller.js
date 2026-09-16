// import model
import { PriceConversion, Currency } from "../models/index.js";
import axios from "axios";
// import controller
import * as binanceCtrl from "./binance.controller.js";
import * as redisCtrl from "./redis.controller.js";

// import lib
import isEmpty from "../lib/isEmpty.js";
import { replacePair, replaceTest } from "../lib/pairHelper.js";

import {
  paginationQuery,
  filterSearchQuery,
  columnFillter,
} from "../lib/adminHelpers.js";
import config from "../config/index.js";

export const getActivePairs = async (allvalues) => {
  if (!allvalues || typeof allvalues !== 'object') {
    return {};
  }
  var keys = Object.values(allvalues);
  let newarray = {};
  for (var i = 0; i < keys.length; i++) {
    var str = [keys[i]];
    str = JSON.parse(str);
    if (str.status === "active") {
      newarray[str.tikerRoot] = str.markPrice;
    }
  }
  return newarray;
};

/**
 * Price conversion in CRON
 */
export const priceCNV = async () => {
  try {
    console.log('-------23')
    let conversionList = await PriceConversion.find({});
    
    const inverseCnv = [];
    const convObj = conversionList.reduce((acc, item) => {
      const key = item.baseSymbol + item.convertSymbol;
      acc[key] = item.convertPrice;
      return acc;
    }, {});
    
    let localPairs = await redisCtrl.hgetall("spotPairdata");
    localPairs = await getActivePairs(localPairs);

    let binancePrice = await binanceCtrl.marketPrice();          

    if (conversionList && conversionList.length > 0) {
      for (let item of conversionList) {
        if (item.fetchFrom == "off") {
          item.baseSymbol = replaceTest(item.baseSymbol)
          item.convertSymbol = replaceTest(item.convertSymbol)
          
          if (inverseCnv.includes(item.baseSymbol + item.convertSymbol)) {
            // console.log("skipping conversion", item.baseSymbol + item.convertSymbol)
            continue;
          }
          
          // The api_key is appended only when CRYPTOCOMPARE_API_KEY is set. It
          // used to be a live key spelled into this URL in tracked source, on a
          // cron that fires every 5 minutes; treat that key as leaked and
          // rotate it. Anonymous requests still work here, at a lower rate
          // limit, so an unset variable degrades rather than breaks.
          const ccKey = config.CRYPTOCOMPARE_API_KEY;
          let apiResponse = await fetch(
            `https://min-api.cryptocompare.com/data/price?fsym=${item.baseSymbol}&tsyms=${item.convertSymbol}` +
              (ccKey ? `&api_key=${ccKey}` : "")
          );
          let apiResponseJson = await apiResponse.json();
          

          if (
            !isEmpty(binancePrice) &&
            Number(binancePrice[item.baseSymbol + replacePair(item.convertSymbol)]) > 0
          ) {
            const convertPrice = binancePrice[item.baseSymbol + replacePair(item.convertSymbol)];
            await PriceConversion.updateOne(
              { _id: item._id },
              {
                $set: {
                  convertPrice,
                  source: "binance",
                },
              }
            );
            await redisCtrl.hset("priceCnv", item.baseSymbol + item.convertSymbol, {
              baseSymbol: item.baseSymbol,
              convertSymbol: item.convertSymbol,
              convertPrice,
            });
            convObj[item.baseSymbol+item.convertSymbol] = convertPrice;

            await PriceConversion.updateOne(
              {
                "baseSymbol": item.convertSymbol,
                "convertSymbol": item.baseSymbol,
              },
              {
                $set: {
                  convertPrice: 1 / convertPrice,
                  source: "binance",
                },
              }
            );
            await redisCtrl.hset("priceCnv", item.convertSymbol + item.baseSymbol, {
              baseSymbol: item.convertSymbol,
              convertSymbol: item.baseSymbol,
              convertPrice: 1 / convertPrice,
            });
            convObj[item.convertSymbol+item.baseSymbol] = 1 / convertPrice;
            inverseCnv.push(item.convertSymbol+item.baseSymbol);
          } else if (apiResponseJson && apiResponseJson[item.convertSymbol]) {
            const convertPrice = apiResponseJson[item.convertSymbol];
            await PriceConversion.updateOne(
              { _id: item._id },
              {
                $set: {
                  convertPrice,
                  source: "cryptocompare",
                },
              }
            )
            await redisCtrl.hset("priceCnv", item.baseSymbol + item.convertSymbol, {
              baseSymbol: item.baseSymbol,
              convertSymbol: item.convertSymbol,
              convertPrice,
            });
            convObj[item.baseSymbol+item.convertSymbol] = convertPrice;

            await PriceConversion.updateOne(
              {
                "baseSymbol": item.convertSymbol,
                "convertSymbol": item.baseSymbol,
              },
              {
                $set: {
                  convertPrice: 1 / convertPrice,
                  source: "cryptocompare",
                },
              }
            );
            await redisCtrl.hset("priceCnv", item.convertSymbol + item.baseSymbol, {
              baseSymbol: item.convertSymbol,
              convertSymbol: item.baseSymbol,
              convertPrice: 1 / convertPrice,
            });
            convObj[item.convertSymbol+item.baseSymbol] = 1 / convertPrice;
            inverseCnv.push(item.convertSymbol+item.baseSymbol);
          } else if (localPairs && localPairs[item.baseSymbol + replacePair(item.convertSymbol)]) {                        
            const convertPrice = localPairs[item.baseSymbol + replacePair(item.convertSymbol)]; 
            await PriceConversion.updateOne(
              { _id: item._id },
              {
                $set: {
                  convertPrice,
                  source: "local",
                },
              }
            );
            await redisCtrl.hset("priceCnv", item.baseSymbol + item.convertSymbol, {
              baseSymbol: item.baseSymbol,
              convertSymbol: item.convertSymbol,
              convertPrice: convertPrice,
            });
            convObj[item.baseSymbol+item.convertSymbol] = convertPrice;

            await PriceConversion.updateOne(
              {
                "baseSymbol": item.convertSymbol,
                "convertSymbol": item.baseSymbol,
              },
              {
                $set: {
                  convertPrice: 1 / convertPrice,
                  source: "local",
                },
              }
            );
            await redisCtrl.hset("priceCnv", item.convertSymbol + item.baseSymbol, {
              baseSymbol: item.convertSymbol,
              convertSymbol: item.baseSymbol,
              convertPrice: 1 / convertPrice,
            });

            convObj[item.convertSymbol+item.baseSymbol] = 1 / convertPrice;
            inverseCnv.push(item.convertSymbol+item.baseSymbol);
          } else if (convObj[replacePair(item.convertSymbol) + "USDT"] && convObj[item.baseSymbol + "USDT"]) {
            let convertPrice =
              convObj[item.baseSymbol + "USDT"] /
              convObj[replacePair(item.convertSymbol) + "USDT"];

            await PriceConversion.updateOne(
              { _id: item._id },
              {
                $set: {
                  convertPrice,
                  source: "usdt",
                },
              }
            );
            await redisCtrl.hset(
              "priceCnv",
              item.baseSymbol + item.convertSymbol,
              {
                baseSymbol: item.baseSymbol,
                convertSymbol: item.convertSymbol,
                convertPrice,
              }
            );
            convObj[item.baseSymbol+item.convertSymbol] = convertPrice;

            await PriceConversion.updateOne(
              {
                "baseSymbol": item.convertSymbol,
                "convertSymbol": item.baseSymbol,
              },
              {
                $set: {
                  convertPrice: 1 / convertPrice,
                  source: "usdt",
                },
              }
            );
            await redisCtrl.hset("priceCnv", item.convertSymbol + item.baseSymbol, {
              baseSymbol: item.convertSymbol,
              convertSymbol: item.baseSymbol,
              convertPrice: 1 / convertPrice,
            });
            convObj[item.convertSymbol+item.baseSymbol] = 1 / convertPrice;
            inverseCnv.push(item.convertSymbol+item.baseSymbol);
          }
        }
      }
    }
  } catch (err) {
    console.log(err, "Error on Price conversion");
  }
};


// priceCNV();
/**
 * Price conversion in CRON
 */
export const BinancePriceUpdate = async () => {
  try {
    let conversionList = await PriceConversion.find({});
    if (conversionList && conversionList.length > 0) {
      let binancePrice = await binanceCtrl.marketPrice();

      for (let item of conversionList) {
        let binanceprice =
          binancePrice[item.baseSymbol + replacePair(item.convertSymbol)];
        if (!isEmpty(binancePrice) && binanceprice) {
          await PriceConversion.updateOne(
            {
              _id: item._id,
            },
            {
              $set: {
                convertPrice: binanceprice,
                fetchFrom: "binance",
              },
            }
          );

          await PriceConversion.updateOne(
            {
              baseSymbol: item.convertSymbol,
              convertSymbol: item.baseSymbol,
            },
            {
              $set: {
                convertPrice: 1 / binanceprice,
                fetchFrom: "binance",
              },
            }
          );
        }
      }
    }
  } catch (err) {
    console.log("Error on BinancePriceUpdate", err);
  }
};

/**
 * Add Price Conversion
 */
export const addPriceCNV = async (currencyData) => {
  try {
    if (currencyData.type == "fiat") {
      let currencyList = await Currency.find({
        type: {
          $in: ["crypto", "token"],
        },
      });
      if (currencyList && currencyList.length > 0) {
        let binancePrice = await binanceCtrl.marketPrice();

        for (let item of currencyList) {
          if (!["USDT"].includes(item.coin)) {
            if (item.coin != currencyData.coin) {
              let checkPrice = await PriceConversion.findOne({
                baseSymbol: item.coin,
                convertSymbol: currencyData.coin,
              });

              if (!checkPrice) {
                let newDoc = {
                  baseSymbol: item.coin,
                  convertSymbol: currencyData.coin,
                  convertPrice:
                    !isEmpty(binancePrice) &&
                      binancePrice[item.coin + replacePair(currencyData.coin)]
                      ? binancePrice[item.coin + replacePair(currencyData.coin)]
                      : 1,
                };
                await redisCtrl.hset(
                  "priceCnv",
                  item.coin + currencyData.coin,
                  newDoc
                );
                await PriceConversion.create(newDoc);
              }
            }
          }
        }
      }
      return true;
    } else if (["crypto", "token"].includes(currencyData.type)) {
      if (["USDT"].includes(currencyData.coin)) {
        return false;
      }

      let currencyList = await Currency.find({
        type: {
          $in: ["fiat"],
        },
      });

      if (currencyList && currencyList.length > 0) {
        let binancePrice = await binanceCtrl.marketPrice();

        for (let item of currencyList) {
          if (item.coin != currencyData.coin) {
            let checkPrice = await PriceConversion.findOne({
              baseSymbol: currencyData.coin,
              convertSymbol: item.coin,
            });

            if (!checkPrice) {
              let newDoc = {
                baseSymbol: currencyData.coin,
                convertSymbol: item.coin,
                convertPrice:
                  !isEmpty(binancePrice) &&
                    binancePrice[currencyData.coin + replacePair(item.coin)]
                    ? binancePrice[currencyData.coin + replacePair(item.coin)]
                    : 1,
              };
              await redisCtrl.hset(
                "priceCnv",
                item.coin + currencyData.coin,
                newDoc
              );
              await PriceConversion.create(newDoc);
            }
          }
        }
      }
      return true;
    }
    return false;
  } catch (err) {
    return false;
  }
};




export const priceConversionGrpc = async (reqBody) => {
  try {
    console.log(reqBody, '-------304')
    const tokenData = await Currency.findOne(
      {
        coin: "CRYPTODEX",
        type: "token"
      }
    )
    let data = await PriceConversion.findOne(
      {
        baseSymbol: reqBody.baseSymbol,
        convertSymbol: reqBody.convertSymbol,
      },
      {
        _id: 0,
        convertPrice: 1,
      }
    );
    if (data) {
      return { status: true, convertPrice: data.convertPrice.toString(), tokenId: tokenData._id.toString() };
    }
    return { status: false };
  } catch (err) {
    return { status: false };
  }
};

export const addPriceConverStion = async () => {
  try {
    let currencyList = await Currency.find({});

    if (currencyList && currencyList.length > 0) {
      let binancePrice = await binanceCtrl.marketPrice();

      for (let item of currencyList) {
        for (let secondCurrency of currencyList) {
          // `symbol` is optional on currency documents — comparing it pairs
          // every currency with itself as undefined != undefined, so no
          // conversion row was ever created. `coin` is the field the rows use.
          if (item.coin != secondCurrency.coin) {
            let checkPrice = await PriceConversion.findOne({
              baseSymbol: item.coin,
              convertSymbol: secondCurrency.coin,
            });

            if (!checkPrice) {
              let newDoc = new PriceConversion({
                baseSymbol: item.coin,
                convertSymbol: secondCurrency.coin,
                convertPrice:
                  !isEmpty(binancePrice) &&
                    binancePrice[item.coin + replacePair(secondCurrency.coin)]
                    ? binancePrice[
                    item.coin + replacePair(secondCurrency.coin)
                    ]
                    : 1,
                fetchFrom: "off",
              });
              await newDoc.save();
              await redisCtrl.hset(
                "priceCnv",
                item.coin + secondCurrency.coin,
                newDoc
              );
            }
          }
        }
      }
    }

    return false;
  } catch (err) {
    console.log("sddddddddd", err);
    return false;
  }
};

addPriceConverStion();
