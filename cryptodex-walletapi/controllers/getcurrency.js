// import model
import { Currency, User } from "../models/index.js";
import * as bnbGateway from "./coin/bnbGateway.js";
import * as ethGateWay from './coin/ethGateway.js';
// import * as tronGateWay from './coin/tronGateway'

import { fetchUser } from '../grpc/userService.js'

export const currencyList = async (req, res) => {
  try {
    let userid = req.user.id;
    let userData = await fetchUser({ "_id": userid });
   
    let data = await Currency.find({ "status": "active" });
    for (var i = 0; i < data.length; i++) {
      if (data[i].type == "crypto") {
        if (data[i].coin == "BNB") {
          bnbGateway.deposit(userid);
        }
        if (data[i].coin == "ETH") {
          // ethGateWay.deposit(userid,userData.userId);
        }
      }
      if (data[i].type == "token") {
        if (data[i].tokenType == "bep20") {
          bnbGateway.tokenDeposit(userid, data[i].symbol, data[i]._id);
        }
        if (data[i].tokenType == "erc20") {

          // ethGateWay.ERC20_Deposit(userid, data[i].symbol,data[i]._id);
          //  ethGateWay.susCriptionDeposit(userid, data[i].symbol,data[i]._id) 

        }
        if (data[i].tokenType == "trc20") {

          tronGateWay.tronTokenDeposit(userid, data[i].symbol, data[i]._id);
        }
      }


    }
  } catch (error) { }
};