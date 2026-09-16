// import package
import mongoose from "mongoose";

const Schema = mongoose.Schema;

const PriceConversionSchema = new Schema({
    baseSymbol: {
        type: String,
        default: ""
    },
    convertSymbol: {
        type: String,
        default: ""
    },
    convertPrice: {
        type: Number,
        required: true
    },
    source: {
        type: String,
        default: ""
    },
    fetchFrom: {
        type: "String",
        enum: ["off", "binance"],
        default: "off"
    }
}, {
    timestamps: true
});

const PriceConversion = mongoose.model("priceconversion", PriceConversionSchema, 'priceconversion');
export default PriceConversion;