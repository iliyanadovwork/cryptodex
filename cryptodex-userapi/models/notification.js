// import package
import mongoose from 'mongoose';

const Schema = mongoose.Schema;
const ObjectId = Schema.ObjectId;

const NotificationSchema = new Schema({
    userId: {
        type: ObjectId,
        ref: 'users',
    },
    title: {
        type: String,
        default: 0
    },
    description: {
        type: String,
        default: 0
    },
    noti_view_status: {
        type: Boolean,
        default: false //notification view status 
    },
    noti_view_status_super_admin: {
        type: Boolean,
        default: false //notification view status 
    },
    noti_view_status_admin: {
        type: Boolean,
        default: false //notification view status 
    },
    currencyId: {
        type: ObjectId,
        ref: 'currency',
    },
    transactionId: {
        type: ObjectId,
        ref: 'transaction',
    },
    trxId: {
        type: String,
        default: '',
    },
    currencySymbol: {
        type: String,
        default: ""
    },
    amount: {
        type: Number,
        default: 0
    },
    paymentType: {
        type: String,
        enum: ['coin_deposit', 'coin_withdraw', 'fiat_deposit', 'fiat_withdraw'],
        default: 'coin_deposit'
    },
    status: {
        type: String,
        enum: ['new', 'pending', 'completed', 'rejected', 'cancel'],
        default: 'new'
    },
    createdAt: {
        type: Date,
        default: Date.now
    },

})

const Notification = mongoose.model("notification", NotificationSchema, 'notification');
export default Notification;