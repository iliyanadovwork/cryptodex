// import package
import mongoose from "mongoose";
const Schema = mongoose.Schema;
const ObjectId = Schema.ObjectId;

const passBookSchema = new Schema({
  userId: {
   // type: ObjectId,
   type: String,
    ref: "user",
  },
  userCodeId: {
    type: String,
    default: "",
  },
  coin: {
    type: String,
    default: "",
  },
  currencyId: {
    type: ObjectId,
    ref: "currency",
  },
  tableId: {
    // Spot Table Id, TransactionTable Id
    type: ObjectId,
    ref : 'transaction'
  },
  beforeBalance: {
    type: Number,
    default: 0,
  },
  afterBalance: {
    type: Number,
    default: 0,
  },
  amount: {
    type: Number,
    default: 0,
  },
  type: {
    type: String,
    // enum: ['coin_deposit', 'coin_withdraw',"fiat_deposit","fiat_withdraw","fiat_transfer","coin_transfer"],
    default: "",
  },
  category: {
    type: String,
    enum: ["credit", "debit"],
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});


const passbook = mongoose.model("passbook", passBookSchema, 'passbook');
export default passbook;