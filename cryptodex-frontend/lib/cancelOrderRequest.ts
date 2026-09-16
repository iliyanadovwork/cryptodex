/**
 * WHAT A CANCEL IS ABOUT.
 *
 * A cancel names ONE order and nothing else. It is built here, from an order
 * object handed in by the caller, so that "which order is this request about"
 * is a pure function of a value rather than of whatever a component's props
 * happen to hold at the moment Confirm is pressed.
 *
 * That distinction is the whole bug this module exists to close. The open-order
 * table used to key its rows by ARRAY POSITION, so when a row above left the
 * table - which happens on its own every time an order fills - React reused the
 * already-mounted cancel control and swapped its `orderInfo` prop underneath an
 * OPEN confirmation dialog. The dialog then read that prop at Confirm time and
 * cancelled whichever order had slid into that index. Measured live on
 * /spot/BTC_USD: a dialog opened on a 61000 buy refunded 12.00 USD, the value
 * of the 60000 buy one row below it, and the 61000 order survived.
 *
 * Two things follow, and both are enforced by construction rather than by
 * keying luck:
 *
 *   1. The dialog captures the order when it OPENS and passes that captured
 *      value here. Nothing this module is given can change after capture,
 *      because it is a value, not a prop.
 *
 *   2. The order is identified by its `_id`. `tableId` is derived from the
 *      SAME order's own side and pair, never from the row's surroundings, so a
 *      snapshot can never be paired with somebody else's table.
 *
 * The server is the last word on authorisation, and it does hold it - proved
 * live, not assumed: a second account asking to cancel this account's resting
 * order by id is answered `400 {"message":"Order not found"}` and the order
 * stays resting (spotapi `cancelAuthorised` requires
 * `String(order.userId) === String(req.user.id)`, that the order is not a paper
 * ladder order, and that `tableId` names the order's own side). So the defect
 * was never a way to touch another user's money - it is a way to destroy the
 * WRONG ONE OF YOUR OWN, which the server cannot possibly detect, because both
 * orders are legitimately yours.
 */

//import lib
import { encryptObject } from "./cryptoJS";
//import service
import { cancelOrder } from "../services/Spot/SpotService";

export type CancelTarget = {
  _id?: string;
  pairId?: string;
  buyorsell?: string;
  type?: string;
  firstFloatDigit?: number;
  secondFloatDigit?: number;
};

/**
 * The plaintext body of POST /api/spot/cancelOrder.
 *
 * `buyorsell` falls back to `type` because the open-order payload spells the
 * side either way depending on whether the row came from the REST page or the
 * socket push, and spotapi rejects a `tableId` that does not start with the
 * order's own side (`cancelAuthorised`).
 */
export const cancelOrderPayload = (order: CancelTarget) => {
  const side = order?.buyorsell || order?.type;
  return {
    tableId: `${side}OpenOrders_` + order?.pairId,
    orderId: order?._id,
    firstFloatDigit: order?.firstFloatDigit,
    secondFloatDigit: order?.secondFloatDigit,
  };
};

/** Two orders are the same order iff they carry the same `_id`. */
export const isSameOrder = (a: any, b: any) =>
  !!a && !!b && !!a._id && String(a._id) === String(b._id);

/** True when `order` is still present in the loaded open-order set. */
export const stillOpen = (order: any, rows: any[]) =>
  Array.isArray(rows) && rows.some((row) => isSameOrder(row, order));

/** Send the cancel for exactly the order handed in. */
export const requestCancel = (order: CancelTarget) =>
  cancelOrder(encryptObject(cancelOrderPayload(order)));
