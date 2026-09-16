import { AdminProfit } from "../models/index.js";
import { IncCntObjId } from "../lib/generalFun.js";

/**
 * THE FEE LEDGER WRITE. THIS IS NOT AN ADMIN ENDPOINT AND IT STAYS.
 * ================================================================
 * spotapi calls this over gRPC (grpc/server.js -> `saveAdminprofit`) every time
 * a trade charges a maker/taker fee - see spotapi controllers/spot.controller.js
 * -> grpc/adminService.saveAdminprofit. Trading fees are explicitly staying on
 * this venue, so the row that records them has to keep being written.
 *
 * What was removed is `profitHistory`, the paginated / CSV / PDF REPORT over
 * these rows that was mounted at GET /api/admin/admin-profit. The
 * data is untouched; only the screen that read it is gone.
 */
export const saveAdminprofit = async (reqBody) => {
  try {
    var saveAdminProfit = {
      userId: reqBody.userId,
      pair: reqBody.pair,
      coin: reqBody.coin,
      fee: reqBody.fee,
      ordertype: reqBody.ordertype,
      userCode: IncCntObjId(reqBody.userId)
    };
    let Profit = new AdminProfit(saveAdminProfit);
    await Profit.save();
    return { status: true };
  } catch (err) {
    return { status: true };
  }
};
