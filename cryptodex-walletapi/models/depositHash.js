// import package
import mongoose from "mongoose";
const Schema = mongoose.Schema;
const ObjectId = Schema.ObjectId;

const depositHashSchema = new Schema({
    coin: {
        type: String,
        default: "",
    },
    currencyId: {
        type: ObjectId,
        ref: "currency",
    },
    hash: {
        type: String,
        default: "",
    },
    tokenType: {
        type: String,
        default: "",
    },
    amount: {
        type: Number,
        default: 0,
    },
    network: {
      type: String,
      enum: ['SOL']
    },
    assetEntry: {
      type: Boolean,
      default: false,
    },
    userAddress: {
        type: String,
        default: "",
    },
    userId: {
        type: ObjectId
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

const DepositHash = mongoose.model("depositHash", depositHashSchema, "depositHash");
export default DepositHash;