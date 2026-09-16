import mongoose from "mongoose";
const Schema = mongoose.Schema;
const ObjectId = Schema.ObjectId;
const AdminProfitSchema = new Schema({
    userId: {
        type: ObjectId,
        ref: 'user',
    },
    userCode: {
        type: String,
        default: "",
    },
    pair: {
        type: String,
        default: ''
    },
    coin: {
        type: String,
        default: ''
    },
    tableId: {
        type: String,
        default: ''
    },
    markup: {
        type: String,
        default: 0
    },
    fee: {
        type: Number,
        default: 0
    },
    ordertype: {
        type: String,
        default: ""
    },
    tradeFee: {
        type: Number,
        default: 0
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});


const adminProfit = mongoose.model('adminProfitHistory', AdminProfitSchema, 'adminProfitHistory');
export default adminProfit;