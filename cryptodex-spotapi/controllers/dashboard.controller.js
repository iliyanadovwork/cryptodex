// import package
import axios from "axios";

import mongoose from "mongoose";
const ObjectId = mongoose.Types.ObjectId;
// import model
import { SpotPair, FavPair } from "../models/index.js";

// import grpc
import { currencySymbol } from "../grpc/currencyService.js";
import isEmpty from "../lib/isEmpty.js";
// config
import config from "../config/index.js";
import { marketPrice } from "./spot.controller.js";
import { hgetall, hget } from '../controllers/redis.controller.js'
import { getActivePairs } from '../controllers/spot.controller.js'
/**
 * Get getGainerLooser
 * URL : /dashboard/gainerLooser
 * METHOD : GET
 */
// export const getGainerLooser = async (req, res) => {
//   let gainData = [],
//     lossData = [];
//   try {
//     let spotpairs = await SpotPair.find({});

//     if (spotpairs.length > 0) {
//       // let respData = await axios({
//       //   method: "get",
//       //   url: `https://api1.binance.com/api/v3/ticker/24hr`,
//       // });
//       for (let item of spotpairs) {
//         // let data = respData.data.find(
//         //   (el) =>
//         //     el.symbol == item.firstCurrencySymbol + item.secondCurrencySymbol
//         // );

//         let markData = await marketPrice(item._id);
//         console.log(markData,"markData", markData.result)
//         if (markData && item) {
//           // let currency = await currencySymbol({
//           //   currencySymbol: item.firstCurrencySymbol,
//           // });

//           // let pic = currency.currencyImage;
//           let sy = "";
//           if (markData.result && markData.result.change > 0) {
//             sy = "+";
//           }
//           let object = {
//             // pic: pic,
//             CoinName: `${item.firstCurrencySymbol}/${item.secondCurrencySymbol}`,
//             Price: parseFloat(markData.result.last).toFixed(4),
//             Percent: sy + parseFloat(markData.result.change).toFixed(4) + "%",
//             Percentage: sy + parseFloat(markData.result.change).toFixed(4),
//           };

//           if (markData.result.change > 0) {
//             gainData.push(object);
//           } else {
//             lossData.push(object);
//           }
//         }
//       }
//     }

//     gainData = gainData.sort(
//       (a, b) => parseFloat(b.Percent) - parseFloat(a.Percent)
//     ); // descending order

//     lossData = lossData.sort(
//       (a, b) => parseFloat(a.Percent) - parseFloat(b.Percent)
//     ); // ascending order

//     let result = {
//       gain: gainData,
//       loss: lossData,
//     };

//     // console.log(result,"resultresultresult")
//     return res.status(200).json({ success: true, result });
//   } catch (err) {
//     console.log(err, "ERERE !@#@!#");
//     //return res.status(500).json({ success: false });
//   }
// };

export const getGainerLooser = async (req, res) => {
  try {
    let gainData = []
    let lossData = []
    let spotPairDoc = await hgetall("spotPairdata");
    if (spotPairDoc) {
      spotPairDoc = await getActivePairs(spotPairDoc);
    }
    if (spotPairDoc?.length > 0) {
      for (let i = 0; i < spotPairDoc.length; i++) {
        await marketPrice(spotPairDoc[i]._id);
        let changesDoc = await hget("spot24hrsChange", spotPairDoc[i]._id);
        changesDoc = JSON.parse(changesDoc);
        let sy = "";
        if (changesDoc?.change > 0) {
          sy = "+";
        }
        let data = {
          pairId: spotPairDoc[i]._id,
          CoinName: `${spotPairDoc[i]?.firstCurrencySymbol}/${spotPairDoc[i]?.secondCurrencySymbol}`,
          Price: parseFloat(changesDoc?.last).toFixed(4),
          Percent: sy + parseFloat(changesDoc?.change).toFixed(4) + "%",
          Percentage: sy + parseFloat(changesDoc?.change).toFixed(4),
        }
        if (changesDoc.change > 0) {
          gainData.push(data);
        } else {
          lossData.push(data);
        }
      }
    }
    let result = {
      gain: gainData,
      loss: lossData,
    };
    return res
      .status(200)
      .json({ success: true, messages: "success", result });
  } catch (err) {
    console.log("err: ", err);
    return res.status(500).json({ status: false, message: "Error occured" });
  }
};
/**
 * Get getfavpair
 * URL : /dashboard/gainerLooser
 * METHOD : GET
 */
export const getfavpair = async (req, res) => {
  try {
    let favpair = await FavPair.find({
      userId: req.user.id,
    });
    return res
      .status(200)
      .json({ success: true, message: "Fetch successfully", result: favpair && favpair[0] ? favpair[0].pairlist : [] });
  } catch (err) {
    console.log(err, "vkrs sqwq");
    return res.status(500).json({ status: false, message: "Error occured" });
  }
};

/**
 * Get updateFairPair
 * URL : /dashboard/gainerLooser
 * METHOD : GET
 */
export const updateFairPair = async (req, res) => {
  try {
    let reqBody = req.body;
    let favpair = await FavPair.find({
      userId: req.user.id,
    });

    if (!isEmpty(favpair)) {
      if (favpair) {
        let Update = await FavPair.updateOne(
          {
            userId: ObjectId(req.user.id),
          },
          { $pull: { pairlist: ObjectId(reqBody.pairId) } },
          {
            new: true,
          }
        ).exec();
        if (Update && Update.modifiedCount != 1) {
          await FavPair.findOneAndUpdate(
            {
              userId: req.user.id,
            },
            { $push: { pairlist: reqBody.pairId } }
          );
        }
      }
    } else {
      await FavPair.updateOne(
        {
          userId: req.user.id,
        },
        { $push: { pairlist: ObjectId(reqBody.pairId) } },
        { upsert: true }
      );
    }

    return res
      .status(200)
      .json({ success: true, message: "FavPair Updated successfully" });
  } catch (err) {
    console.log(err, "vkrs sqwq");
    return res.status(500).json({ status: false, message: "Error occured" });
  }
};

// `getNotification` was here. It counted the last 24h of completed trades for
// an operator notification badge and was mounted only on
// `GET /api/admin/getNotification`, so it went with routes/admin.route.js.
//
// The rest of this file stays: getGainerLooser, getfavpair and updateFairPair
// are USER routes on /api/dashboard, authenticated with the `usersAuth`
// strategy, and the frontend calls all three.
