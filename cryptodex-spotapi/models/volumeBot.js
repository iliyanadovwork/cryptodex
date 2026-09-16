// import package
import { stringToSubchannelAddress } from '@grpc/grpc-js/build/src/subchannel-address.js';
import mongoose from 'mongoose';

const Schema = mongoose.Schema;
const ObjectId = Schema.ObjectId;

const VolumeBotSchema = new Schema({
    pairId: {
        type: ObjectId,
        required: true,
        ref: 'spotpair',
    },
    status: {
        type: String,
        enum: ['active', 'deactive'],
        default: 'active'
    },
    price: {
        type: String,
        default: 0
    },
    count: {
        type: String,
        default: 0
    },
    currentSide: {
        type: String,
        default: ""
    },
    lastMarketPrice: {
        type: String,
        default: ''
    },
    onHourTime: {
        type: Date,
        default: Date.now()
    },
    quantity: {
        type: String,
        default: 0
    },
    side: {
        type: String,
        default: ''
    }

}, {
    timestamps: true
});

const VolumeBot = mongoose.model('volumeBot', VolumeBotSchema, 'volumeBot');

export default VolumeBot;