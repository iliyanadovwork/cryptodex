// import package
import mongoose from "mongoose";

// import config
import config from "../config/index.js";

// import lib
import isEmpty from "../lib/isEmpty.js";

const Schema = mongoose.Schema;
const ObjectId = Schema.ObjectId;

const TransactionSchema = new Schema({
  userId: {
    type: String,
    // required: true
  },
  currencyId: {
    type: ObjectId,
    ref: "currency",
  },
  coin: {
    type: String,
    default: "",
  },
  assetId: {
    type: String,
    default: "",
  },
  tokenType: {
    type: String,
    default: "",
  },
  fromAddress: {
    type: String,
    default: "",
  },
  toAddress: {
    type: String,
    default: "",
  },
  destTag: {
    type: String,
    default: "",
  },
  amount: {
    type: Number, // with commission fee
    default: 0,
  },
  actualAmount: {
    type: Number,
    default: 0, // without Commission Fee
  },
  commissionFee: {
    type: Number,
    default: 0,
  },
  txid: {
    type: String,
  },
  userCode: {
    type: String,
    default: "",
  },
  status: {
    type: String,
    enum: ["new", "pending", "completed", "rejected", "processing"],
  },
  type: {
    type: String,
    enum: ["local", "coin_payment", "binance", "fireblocks"],
    default: "local",
  },
  paymentType: {
    type: String,
    enum: [
      "coin_deposit",
      "coin_withdraw",
      "coin_transfer",
      "fiat_deposit",
      "fiat_withdraw",
      "fiat_withdraw",
      "fiat_transfer",
      "admin_deposit",
      "admin_withdraw",
      "spot_to_p2p",
      "p2p_to_spot",
    ],
    default: "coin_deposit",
  },
  bankDetail: {
    type: Object,
    default: null,
  },
  contractAddress: {
    type: String,
    default: "",
  },
  image: {
    type: String,
    get: (image) => {
      if (isEmpty(image)) {
        return "";
      }
      return `${config.SERVER_URL}${config.IMAGE.DEPOSIT_URL_PATH}${image}`;
    },
    default: "",
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

TransactionSchema.set("toObject", { getters: true });
TransactionSchema.set("toJSON", { getters: true });

const Transaction = mongoose.model(
  "transaction",
  TransactionSchema,
  "transaction"
);

export default Transaction;
