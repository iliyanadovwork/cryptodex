// import package
import mongoose from 'mongoose';

const Schema = mongoose.Schema;

const smslog = new Schema({
    phoneCode: {
        type: String,
        default: ''
    },
    phoneNo: {
        type: String,
        default: ''
    },
    userId:{
        type: String,
        default: ''
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
})
const Smslog = mongoose.model("smslog", smslog, "smslog");

export default Smslog;