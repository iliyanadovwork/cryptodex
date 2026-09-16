// import package
import mongoose from 'mongoose';

const Schema = mongoose.Schema;
const ObjectId = Schema.ObjectId;

const TradeBotSchema = new Schema({
    pairId: {
        type: ObjectId,
        required: true,
        ref: 'spotpair',
    },
    side: {
        type: [String],
        enum: ["buy", "sell"],
    },
    buyPercent: {
        type: Number,
        default: 0
    },
    sellPercent: {
        type: Number,
        default: 0
    },
    buyStartPricePerc: {
        type: Number,
        default: 0
    },
    buyEndPricePerc: {
        type: Number,
        default: 0
    },
    sellStartPricePerc: {
        type: Number,
        default: 0
    },
    sellEndPricePerc: {
        type: Number,
        default: 0
    },
    startQuantity: {
        type: Number,
        required: true,
    },
    endQuantity: {
        type: Number,
        required: true,
    },
    count: {
        type: Number,
        required: true,
    },
    lastMarketPrice: {
        type: String,
        default: ''
    },
    status: {
        type: String,
        enum: ['active', 'deactive'],
        default: 'active'
    },
}, {
    timestamps: true
});

const TradeBot = mongoose.model('tradeBot', TradeBotSchema, 'tradeBot');

export default TradeBot;