import mongoose from "mongoose";
const Schema = mongoose.Schema;

let profitlossschema = new Schema({
    userId: {
        type: String,
        required: true
    },
    currencySymbol: {
        type: String,
        default: "",
    },
    amount: {
        type: Number,
        default: 0,
    },
    profit_loss: {
        type: Number,
        default: 0,
    },
    profit_loss_percentage: {
        type: Number,
        default: 0,
    },
    deposit_withdraw: {
        type: Number,
        default: 0,
    },
    amount_btc: {
        type: Number,
        default: 0,
    },
    profit_loss_btc: {
        type: Number,
        default: 0,
    },
    profit_loss_percentage_btc: {
        type: Number,
        default: 0,
    },
    deposit_withdraw_btc: {
        type: Number,
        default: 0,
    },
    status: {
        type: Number,
        default: 1,
    },
    created_date: {
        type: Date,
        default: Date.now,
    },
});

const ProfitLoss = mongoose.model("ProfitLoss", profitlossschema, "ProfitLoss");

export default ProfitLoss;