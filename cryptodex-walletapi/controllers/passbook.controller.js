//import models
import { Passbook } from "../models/index.js";
import Smslog from "../models/smslog.js";
import mongoose from "mongoose";
import "csv-express";
// import lib
import {
  paginationQuery,
  filterSearchQuery,
  columnFillter,
} from "../lib/adminHelpers.js";
import isEmpty from "../lib/isEmpty.js";
import { IncCntObjId } from "../lib/generalFun.js";
import { momentFormat } from "../lib/dateTimeHelper.js";
/*
 CREATE PASSBOOK
*/
/**
 * Numeric fields of a passbook row. Every one of them is a balance/amount that
 * the ledger has ALREADY moved, so a row that cannot be cast is an audit record
 * that is about to be lost - it must be reported, never repaired here and never
 * accepted as NaN by the schema.
 */
export const PASSBOOK_NUMERIC_FIELDS = ["beforeBalance", "afterBalance", "amount"];

/**
 * Fields whose value is not a finite number. Returns [] for a valid row.
 */
export const invalidPassbookNumbers = (data) =>
  PASSBOOK_NUMERIC_FIELDS.filter(
    (field) => !Number.isFinite(parseFloat(data?.[field]))
  );

/**
 * The two BALANCE fields. `amount` is deliberately NOT one of them: a negative
 * amount is legitimate - a debit books a negative delta. A negative *balance*
 * is not - no wallet in this exchange can hold less than nothing.
 */
export const PASSBOOK_BALANCE_FIELDS = ["beforeBalance", "afterBalance"];

/**
 * Balance fields that are negative, i.e. describe a wallet state that cannot
 * exist. Returns [] for a valid row.
 *
 * Live source of these: the spot order-place insufficient-balance recovery.
 * It debits Redis first (HINCRBYFLOAT walletbalance_spot by -orderValue),
 * notices the result went below zero, immediately credits the difference back
 * and rejects the order - but it books BOTH halves of that round trip to the
 * passbook, quoting the transient sub-zero figure as `afterBalance` on the
 * first row and as `beforeBalance` on the second. That number was never a
 * balance anyone held; it existed for the microseconds between two Redis
 * commands, and the pair nets to zero movement. Storing it produces an audit
 * row that reads as "this account went overdrawn", which is exactly the thing
 * a paper-trading ledger must never appear to have done.
 */
export const impossiblePassbookBalances = (data) =>
  PASSBOOK_BALANCE_FIELDS.filter((field) => parseFloat(data?.[field]) < 0);

/**
 * Persist one passbook row.
 *
 * Returns the saved document, or NULL when the row could not be written. It
 * never throws: most call sites are fire-and-forget (no await, no catch), so a
 * rejection here would surface as an unhandled promise rejection rather than as
 * a missing audit row. Callers that can report the failure - the gRPC handler -
 * check for null.
 *
 * It used to `return err` from the catch, which is truthy and therefore
 * indistinguishable from a saved document: a NaN balance was dropped in total
 * silence apart from a console dump.
 */
export const createPassBook = async (data) => {
  try {
    console.log("categorycategorycategory", data);

    // Reject BEFORE mongoose casts: NaN balances mean the row is about to be
    // lost, and the fix belongs in whoever computed the balance, never in the
    // schema.
    const invalid = invalidPassbookNumbers(data);
    if (invalid.length > 0) {
      console.error(
        "[Passbook] AUDIT ROW LOST: non-numeric",
        invalid.join(", "),
        {
          userId: data?.userId,
          coin: data?.coin,
          type: data?.type,
          tableId: data?.tableId,
          beforeBalance: data?.beforeBalance,
          afterBalance: data?.afterBalance,
          amount: data?.amount,
        }
      );
      return null;
    }

    // Refuse rows that describe a balance no wallet can hold. Unlike the NaN
    // case above nothing is lost here: the only writer is the insufficient
    // balance recovery, which over-debits and re-credits within the same
    // request, so the pair it books nets to zero movement and the surviving
    // ledger is unchanged - minus two rows claiming the account went negative.
    const impossible = impossiblePassbookBalances(data);
    if (impossible.length > 0) {
      console.error(
        "[Passbook] IMPOSSIBLE AUDIT ROW REFUSED: negative",
        impossible.join(", "),
        {
          userId: data?.userId,
          coin: data?.coin,
          type: data?.type,
          tableId: data?.tableId,
          beforeBalance: data?.beforeBalance,
          afterBalance: data?.afterBalance,
          amount: data?.amount,
        }
      );
      return null;
    }

    data["userCodeId"] = IncCntObjId(data.userId);
    data["beforeBalance"] = parseFloat(data.beforeBalance);
    data["afterBalance"] = parseFloat(data.afterBalance);
    data["amount"] = parseFloat(data.amount);
    let newData = new Passbook(data);

    return await newData.save();
  } catch (err) {
    console.error("[Passbook] AUDIT ROW LOST:", err?.message, {
      userId: data?.userId,
      coin: data?.coin,
      type: data?.type,
    });
    return null;
  }
};
/*
 CREATE SMS LOG
*/

export const smsdatalog = async (data) => {
  console.log(data, "123");
  try {
    var data1 = {};

    (data1["phoneCode"] = data.phoneCode),
      (data1["phoneNo"] = data.phoneNo),
      (data1["userId"] = data.userId);

    let newData = new Smslog(data1);
    await newData.save();
  } catch (err) {
    console.log(err, "e123");
  }
};
