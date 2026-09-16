// import package
import mongoose from "mongoose";

const Schema = mongoose.Schema;

const SequenceIdSchema = new Schema({
  type: {
    type: String,
    enum: ["orderHistory"],
    required: true,
    index: true,
  },
  lastIndex: {
    type: Number,
    default: 0,
  },
});

const SequenceId = mongoose.model("sequenceId", SequenceIdSchema, "sequenceId");
export default SequenceId;
