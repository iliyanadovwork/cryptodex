// import package
import mongoose from "mongoose";

const Schema = mongoose.Schema;
const ObjectId = Schema.ObjectId;

const PairListSchema = new Schema({
  _id: {
    type: ObjectId, // Currency Id
    ref: "spotpairs",
  },
});

const favSchema = new Schema({
  userId: {
    type: Schema.Types.ObjectId,
    ref: "users",
  },
  pairlist: [Schema.Types.ObjectId],

  createdate: {
    type: Date,
    default: Date.now,
  },
});

const favouritepair = mongoose.model(
  "favouritepair",
  favSchema,
  "favouritepair"
);

export default favouritepair;
