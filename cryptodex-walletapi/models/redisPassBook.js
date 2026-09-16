// import package
import mongoose from "mongoose";
const Schema = mongoose.Schema;
const ObjectId = Schema.ObjectId;

const redisPassBookSchema = new Schema({
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
  redisBalance: {
    type: Number,
    default: 0,
  },
  dbBalance: {
    type: Number,
    default: 0,
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const redisPassBook = mongoose.model("redisPassBook", redisPassBookSchema, "redisPassBook");

export default redisPassBook;

