import mongoose from 'mongoose';
const Schema = mongoose.Schema;

let userBalanceschema = new Schema({
    userId: {
        type: String,
        default: "",
    },
    currencySymbol: {
        type: String,
        default: "",
    },
    amount: {
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

const UserBalanceschema = mongoose.model("userBalanceHistory", userBalanceschema, 'userBalanceHistory');
export default UserBalanceschema;