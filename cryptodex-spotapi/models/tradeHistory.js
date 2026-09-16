// import package
import mongoose from "mongoose";

const Schema = mongoose.Schema;
const ObjectId = Schema.ObjectId;

const TradeHistorySchema = new Schema({
  pairId: {
    type: ObjectId,
    ref: "spotpairs",
  },
  firstCurrency: {
    type: String,
    default: "",
  },
  firstCurrencyId: {
    type: ObjectId,
    ref: "currency",
  },
  secondCurrency: {
    type: String,
    default: "",
  },
  secondCurrencyId: {
    type: ObjectId,
    ref: "currency",
  },
  buyUserId: {
    type: ObjectId,
    ref: "user",
  },
  sellUserId: {
    type: ObjectId,
    ref: "user",
  },
  buyOrderId: {
    type: ObjectId,
    ref: "user",
  },
  sellOrderId: {
    type: ObjectId,
    ref: "user",
  },
  buyUserCode: {
    type: String,
    default: "",
  },
  sellUserCode: {
    type: String,
    default: "",
  },
  buyOrdCode: {
    type: String,
    default: "",
  },
  sellOrdCode: {
    type: String,
    default: "",
  },
  execPrice: {
    type: Number,
    default: 0,
  },
  quantity: {
    type: Number,
    default: 0,
  },
  sellerOrderPrice: {
    type: Number,
    default: 0,
  },
  buyeOrderPrice: {
    type: Number,
    default: 0,
  },
  sellOrderType: {
    type: String,
    default: "",
  },
  buyOrderType: {
    type: String,
    default: "",
  },
  isMaker: {
    type: String,
    default: "",
  },
  pairName: {
    type: String,
    default: "",
  },
  orderValue: {
    type: Number,
    default: 0,
  },
  status: {
    type: String,
    enum: ["completed"],
  },
  createdAt: {
    type: Date,
  },
  tradePrice: {
    type: Number,
    default: 0,
  },
  tradeQty: {
    type: Number,
    default: 0,
  },
  liquidityType: {
    type: String,
    default: "",
  },
  uniqueId: {
    type: String,
    // default: ""
  }
});

const TradeHistory = mongoose.model(
  "tradeHistory",
  TradeHistorySchema,
  "tradeHistory"
);

export default TradeHistory;
