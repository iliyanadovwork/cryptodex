
// import package

// import lib
import mongoose from 'mongoose';
import isEmpty from '../lib/isEmpty.js';
const ObjectId = mongoose.Types.ObjectId;
export const paginationQuery = (query = {}) => {

  let pagination = {
    skip: 0,
    limit: 10,
    page: 1
  }

  if (!isEmpty(query) && !isEmpty(query.page) && !isEmpty(query.limit)) {
    pagination['skip'] = (query.page - 1) * query.limit;
    pagination['limit'] = Number(query.limit)
    pagination['page'] = Number(query.page)
  }

  return pagination;
}

/**
 * IS THERE ANOTHER PAGE AFTER THE ONE JUST BUILT?
 * ===============================================
 *
 * Every paged reader on this service used to answer that with
 *
 *     nextPage: data.length <= 0 ? true : false
 *
 * which is the truth turned inside out: it claims another page exists exactly
 * when the page it just built is EMPTY, and claims none exists exactly when the
 * page is FULL. Client-side that flag is `hasMore` on the infinite scroller, so
 * every table it governed was pinned to its first page for as long as it had
 * rows - and on the spot OPEN-ORDERS table, which is the only place a resting
 * spot order can be cancelled, the eleventh order onwards was invisible and
 * therefore uncancellable, with its reservation stuck in the in-order ledger.
 *
 * @param skip   rows skipped to reach this page (pagination.skip)
 * @param length rows ON this page, AFTER slicing
 * @param count  rows in the WHOLE result set, measured BEFORE slicing
 *
 * `count` measured after the slice is the other half of the same bug: it then
 * equals the page size, `skip + length < count` is false on page 1, and the
 * client is told the ten rows it holds are all there are. Take `count` first.
 *
 * A reader that hands back its ENTIRE result set in one message - every socket
 * push here does - has no page after it and must pass `false` outright rather
 * than call this.
 */
export const hasNextPage = (skip, length, count) => {
  const s = Number(skip);
  const l = Number(length);
  const c = Number(count);
  if (!Number.isFinite(s) || !Number.isFinite(l) || !Number.isFinite(c)) {
    return false;
  }
  return s + l < c;
};

export const filterQuery = (query = {}, nonRegExp = []) => {
  let filter = {};

  if (!isEmpty(query)) {
    for (const [key, value] of Object.entries(query)) {
      if (key != 'page' && key != 'limit') {
        if (nonRegExp.includes(key)) {
          filter[key] = Number(value);
        } else {
          filter[key] = new RegExp(value, 'i');
        }
      }
    }
  }
  return filter;
}

export const filterProofQuery = (query = {}, nonRegExp = [], additionKey = '') => {
  let filter = {};

  if (!isEmpty(query)) {
    for (const [key, value] of Object.entries(query)) {
      if (key != 'page' && key != 'limit') {
        if (nonRegExp.includes(key)) {
          filter[additionKey + '.' + key] = Number(value);
        } else {
          filter[additionKey + '.' + key] = new RegExp(value, 'i');
        }
      }
    }
  }
  return filter;
}

export const filterSearchQuery = (query = {}, fields = []) => {
  console.log('search is working', fields)
  let filterQuery = {}
  if (!isEmpty(query) && !isEmpty(query.search)) {
    let filterArray = []
    for (const key of fields) {
      let filter = {};
      filter[key] = new RegExp(query.search, 'i');
      filterArray.push(filter)
    }
    filterQuery = { "$or": filterArray };
  }
  console.log(filterQuery, 'filterquery');
  return filterQuery
}

/**
 * Filter
 * fs_ -> Filter String
 * fn_ -> Filter Number
 * fd_ -> Filter Date
 */
//  export const columnFillter = (query = {}) => {
//     let fillterObj = JSON.parse(query.fillter);
//     let filterQuery = {};
//     if (!isEmpty(fillterObj)) {
//       for (const key in fillterObj) {
//         if (key.substring(0, 3) == "fs_") {
//           filterQuery[key.replace("fs_", "")] = new RegExp(fillterObj[key], "i");
//         }
//       }
//     }
//     console.log("filterQueryfilterQuery",filterQuery)
//     return filterQuery;
//   };

export const columnFillter = (query = {}) => {
  let fillterObj = JSON.parse(query.fillter);

  let filterQuery = {};
  if (!isEmpty(fillterObj)) {
    const conditions = [];
    for (const key in fillterObj) {
      if (key.substring(0, 3) == "fs_") {
        //pair filter
        if (key == "fs_pair") {
          return filterQuery = {
            $or: [{
              firstCoin: new RegExp(
                fillterObj[key],
                "i"
              )
            }, {
              secondCoin: new RegExp(
                fillterObj[key],
                "i"
              )
            }]
          }
        }
        // google 2fa status fillter
        if (key.replace("fs_", "") == "google2Fa.secret") {
          if (fillterObj[key] == "Enabled") {
            filterQuery = {
              [key.replace("fs_", "")]: { $ne: "" },
            };
          } else if (fillterObj[key] == "Disabled") {
            filterQuery = {
              [key.replace("fs_", "")]: { $eq: "" },
            };
          } else if (fillterObj[key] == "All") {
            filterQuery;
          }
        }
        //active status
        else if (fillterObj[key] == "active") {
          filterQuery = {
            [key.replace("fs_", "")]: { $eq: "active" },
          };
        } else if (fillterObj[key] == "all") {
          filterQuery;
        }
        //kyc fillter
        else if (key.replace("fs_", "") == "kycStatus") {
          if (fillterObj[key] == "approved") {
            filterQuery = {
              $and: [
                { "idProof.status": "approved" },
                { "addressProof.status": "approved" },
              ],
            };
          } else if (fillterObj[key] == "pending") {
            filterQuery = {
              $or: [
                { "idProof.status": "pending" },
                { "idProof.status": "rejected" },
                { "addressProof.status": "rejected" },
                { "addressProof.status": "pending" },
              ],
            };
          } else if (fillterObj[key] == "") {
            filterQuery;
          }
        } else if (
          key.replace("fs_", "") == "status" ||
          key.replace("fs_", "") == "emailStatus" ||
          key.replace("fs_", "") == "phoneStatus"
        ) {
          if (fillterObj[key] == "") {
            filterQuery;
          } else {
            filterQuery[key.replace("fs_", "")] = { $eq: fillterObj[key] }
          }
        }
        else if (key.replace("fs_", "") == "isMaker") {
          // original.buyUserId == original.adminId ? "Sell" : "Buy"

          if (fillterObj[key] == "buy") {
            filterQuery.buyUserId = { $ne: ObjectId(fillterObj.adminId) }
          } else if (fillterObj[key] == "sell") {
            filterQuery.buyUserId = { $eq: ObjectId(fillterObj.adminId) }
          }
        }
        //string fillter
        else {
          // filterQuery = {
          //   [key.replace("fs_", "")]: new RegExp(fillterObj[key], "i"),
          // };
          filterQuery[key.replace("fs_", "")] = new RegExp(
            fillterObj[key],
            "i"
          );
          // console.log(
          //   "string filtere .............. eneteteteteteet",
          //   filterQuery
          // );
        }
      }
      //date fillter
      else if (key.substring(0, 3) == "fd_") {
        if (fillterObj["sefd_orderDate"] && !isEmpty(fillterObj["fd_orderDate"])) {
          delete fillterObj["sefd_orderDate"]
        }
        if (fillterObj["sefd_createdAt"] && !isEmpty(fillterObj["fd_createdAt"])) {
          delete fillterObj["sefd_createdAt"]
        }
        console.log(fillterObj, "fillterObj");
        let startDate = new Date(fillterObj[key]);
        let endDate = new Date(fillterObj[key]);
        startDate.setUTCHours(0, 0, 0, 0);
        endDate.setUTCHours(23, 59, 59, 999);
        startDate = new Date(startDate.getTime() - (5.5 * 60 * 60 * 1000));
        endDate = new Date(endDate.getTime() - (5.5 * 60 * 60 * 1000));
        filterQuery[key.replace("fd_", "")] = {
          $gte: startDate,
          $lt: endDate,
        };
        // filterQuery = {
        //   [key.replace("fd_", "")]: {
        //     $gte: startDate,
        //     $lt: endDate,
        //   },
        // };

        // console.log(
        //   "fillterObj[key]fillterObj[key]fillterObj[key]",
        //   filterQuery
        // );
        if (key === "fd_startTimeStamp" || key === "fd_endTimeStamp") {
          const toTimestamp = (strDate) => {
            const dt = Date.parse(strDate);
            return dt;
          };
          let startDate = new Date(fillterObj[key]);
          let endDate = new Date(fillterObj[key]);
          startDate.setHours(0, 0, 0, 0);
          endDate.setHours(23, 59, 59, 999);
          var start = toTimestamp(startDate);
          var end = toTimestamp(endDate);
          filterQuery = {
            [key.replace("fd_", "")]: {
              $gte: start,
              $lt: end,
            },
          };
        }
      } else if (key.substring(0, 5) == "sefd_") {

        // console.log(
        //   "fillterObj[key]fillterObj[key]fillterObj[key]",
        //   fillterObj[key]
        // );
        // if (!isEmpty(fillterObj[key])) {
        let startDate = new Date(fillterObj[key].startDate);
        let endDate = new Date(fillterObj[key].endDate);
        startDate.setHours(0, 0, 0, 0);
        endDate.setHours(23, 59, 59, 999);

        filterQuery[key.replace("sefd_", "")] = {
          $gte: startDate,
          $lt: endDate,
        };
        // filterQuery = {
        //   [key.replace("sefd_", "")]: {
        //     $gte: startDate,
        //     $lt: endDate,
        //   },
        // };
        // }
      }
      //number fillter



      else if (key.substring(0, 3) == "fn_") {
        if (fillterObj[key] == 'market') {
          filterQuery[key.replace("fn_", "")] = fillterObj[key];
        }
        else if(key.endsWith("buyerFee") || key.endsWith("sellerFee")){
          if (key.endsWith("buyerFee")) {
            const regexPattern = new RegExp(parseFloat(fillterObj[key]).toString(), "i");
            conditions.push({
              $expr: {
                $regexMatch: {
                  input: { $toString: "$buyerFee" },
                  regex: regexPattern
                }
              }
            });
          }
          if (key.endsWith("sellerFee")) {
            const regexPattern = new RegExp(parseFloat(fillterObj[key]).toString(), "i");
            conditions.push({
              $expr: {
                $regexMatch: {
                  input: { $toString: "$sellerFee" },
                  regex: regexPattern
                }
              }
            });
          }
          if (conditions.length > 0) {
            filterQuery = {
              ...filterQuery,
              $and: conditions
            };
          }
        }
        else {
          filterQuery[key.replace("fn_", "")] = parseFloat(fillterObj[key]);
        }
      }
      else if (key.substring(0, 3) === "fid") {
        filterQuery[key.replace("fid", "")] = fillterObj[key].length === 24 ? ObjectId(fillterObj[key]) : "";
      }


    }
  }
  return filterQuery;
};

export const tradeHistoryFilter = (query) => {
  const filterQuery = JSON.parse(query.fillter)
  let filtrate = {}

  filtrate.buyUserId = filterQuery.fs_buyUserId
  filtrate.sellUserId = filterQuery.fs_sellUserId

  let colFilt = columnFillter(query)
  if (filterQuery.fs_buyUserId) delete colFilt['buyUserId']
  if (filterQuery.fs_sellUserId) delete colFilt['sellUserId']

  let finalFilter = {
    $or: [
      { buyUserId: new mongoose.Types.ObjectId(filtrate.buyUserId) },
      { sellUserId: new mongoose.Types.ObjectId(filtrate.sellUserId) },
    ],
    ...colFilt
  }
  return finalFilter;

}

export const percentCalc = (OldValue, NewValue) => {
  console.log(OldValue, NewValue, "OldValue, NewValue")
  let Percentage = 0;

  if (OldValue > 0 && NewValue > 0) {
    let difference = NewValue - OldValue;

    if (difference > 0) {
      return (difference / OldValue) * 100;
    } else {
      return Percentage;
    }
  }
  return Percentage;
}