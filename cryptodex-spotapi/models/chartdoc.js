// import package
import mongoose from "mongoose";

const Schema = mongoose.Schema;

const ChartSchema = new Schema({
    pair: {
        type: String,
        default: "",
    },
    low: {
        type: Number,
        default: 0,
    },
    high: {
        type: Number,
        default: 0,
    },
    open: {
        type: Number,
        default: 0,
    },
    close: {
        type: Number,
        default: 0,
    },
    date: {
        type: Date,
        default: Date.now(),
        index: true
    },
});

// const ChartHistory = mongoose.model("chartDoc", ChartDocHistory, "chartDoc");

export default ChartSchema;
