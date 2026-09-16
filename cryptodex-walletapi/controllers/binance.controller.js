import axios from "axios";

// import config
import { binanceApiNode } from "../config/binance.js";

export const marketPrice = async () => {
  try {
    return binanceApiNode.prices();
  } catch (err) {
    return "";
  }
};


/**
 * Get Sub-account Deposit Address (For Master Account)
 * email(required=true), coin(required=true), timestamp(required=true)
 */
export const subAccDepAddr = async (reqData) => {
  try {
    if (isEmpty(reqData)) {
      return {
        status: false,
      };
    }

    let payload = {
      email: reqData.email,
      coin: reqData.coin,
      timestamp: getTimeStamp(),
    };
    payload["signature"] = generateSign(
      config.BINANCE_GATE_WAY.API_SECRET,
      payload
    );

    const respData = await axios({
      url: `/sapi/v1/capital/deposit/subAddress`,
      method: "get",
      params: payload,
    });
    return {
      status: true,
      coin: respData.data.coin,
      address: respData.data.address,
      tag: respData.data.tag,
    };
  } catch (err) {
    return {
      status: false,
    };
  }
};
