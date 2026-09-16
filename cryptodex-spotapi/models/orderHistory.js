// import package
import mongoose from "mongoose";

const Schema = mongoose.Schema;
const ObjectId = Schema.ObjectId;

const OrderHistorySchema = new Schema({
  orderId: {
    type: ObjectId,
    // ref: 'spotpairs',
  },
  orderCode: {
    type: String,
    default: "",
  },
  pairId: {
    type: ObjectId,
    ref: "spotpairs",
  },
  userId: {
    type: ObjectId,
    ref: "users",
  },
  userCode: {
    type: String,
    default: "",
  },
  firstCurrencyId: {
    type: ObjectId,
    ref: "currency",
  },
  firstCurrency: {
    type: String,
    default: "",
  },
  firstFloatDigit: {
    type: Number,
    default: "",
  },
  secondCurrencyId: {
    type: ObjectId,
    ref: "currency",
  },
  secondCurrency: {
    type: String,
    default: "",
  },
  secondFloatDigit: {
    type: Number,
    default: "",
  },
  quantity: {
    ofMixed: Number,
    defalut: "",
  },
  price: {
    type: Schema.Types.Mixed,
    defalut: 0,
  },
  orderValue: {
    type: Number,
    defalut: 0,
  },
  openOrderValue: {
    type: Number,
    defalut: 0,
  },
  pairName: {
    type: String,
    default: "",
  },
  orderType: {
    type: String,
    default: "",
  },
  buyorsell: {
    type: String,
    default: "",
  },
  openQuantity: {
    type: Number,
    default: 0,
  },
  averagePrice: {
    type: Number,
    default: 0,
  },
  filledQuantity: {
    type: Number,
    default: 0,
  },
  flag: {
    type: Boolean,
    required: true,
  },
  status: {
    type: String,
    defalut: "open",
    enum: ["open", "pending", "completed", "cancel"],
  },
  updatedAt: {
    type: Date,
  },
  orderDate: {
    type: Date,
  },
  liquidityId: {
    type: String,
    default: "",
  },
  liquidityType: {
    type: String,
    enum: ["local", "binance", "admin"],
    default: "local",
  },
  isLiquidity: {
    type: Boolean,
    default: false,
  },
  isLiquidityError: {
    type: Boolean,
    default: false,
  },
  isMaker: {
    type: Boolean,
    default: false,
  },
  /**
   * MAKER OR TAKER - decided at ARRIVAL, never re-derived.
   *
   * WHY THIS PATH HAS TO EXIST. lib/liquidityRole.js stamps every accepted
   * order with the role it played when it arrived, because that is the only
   * moment at which "was this order resting when the other side came?" can be
   * observed: the synthetic ladder is rebuilt from scratch every 2s with fresh
   * ids and a backdated orderDate, so by match time there is nothing left to
   * read it off. limitOrderPlace wrote the stamp, redis carried it - and this
   * schema did not declare it, so mongoose STRICT MODE (the default) dropped it
   * silently on the way to `orderHistory`. Nothing threw and nothing logged; the
   * order simply came back off disk with no role on it, and roleOf() resolves an
   * absent role to TAKER. Any path that rehydrates an order from mongo therefore
   * re-billed a passive maker at the taker rate - the exact defect the stamp was
   * introduced to fix, reintroduced by omission one layer down.
   *
   * The default is TAKER for the same reason roleOf's fallback is: it is the
   * rate this service has always charged, so a row written before the field
   * existed reads back as it always settled, and a misconfiguration fails
   * towards the HIGHER of the two published rates rather than silently handing
   * money away.
   */
  liquidityRole: {
    type: String,
    enum: ["maker", "taker"],
    default: "taker",
  },
});

const OrderHistory = mongoose.model(
  "orderHistory",
  OrderHistorySchema,
  "orderHistory"
);

export default OrderHistory;
