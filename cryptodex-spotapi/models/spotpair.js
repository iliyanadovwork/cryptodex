// import package
import mongoose from 'mongoose';

const Schema = mongoose.Schema;
const ObjectId = Schema.ObjectId;

let spotPairsSchema = new Schema({
	tikerRoot: {
		type: String,
		required: true,
	},
	firstCurrencyId: {
		type: ObjectId,
		required: true,
		ref: 'currency'
	},
	firstCurrencySymbol: {
		type: String,
		required: true,
		default: '',
	},
	firstFloatDigit: {
		type: Number,
		default: 8
	},
	secondCurrencyId: {
		type: ObjectId,
		required: true,
		ref: 'currency'
	},
	secondCurrencySymbol: {
		type: String,
		required: true,
		default: '',
	},
	secondFloatDigit: {
		type: Number,
		default: 8
	},
	minPricePercentage: {
		type: Number,
		default: 0
	},
	maxPricePercentage: {
		type: Number,
		default: 0
	},
	maxQuantity: {
		type: Number,
		default: 0
	},
	minQuantity: {
		type: Number,
		default: 0
	},
	maxOrderValue: {
		type: Number,
		default: 0
	},
	minOrderValue: {
		type: Number,
		default: 0
	},
	last: {
		type: Number,
		default: 0
	},
	prevMarkPrice: {
		type: Number,
		default: 0
	},
	markPrice: {
		type: Number,
		default: 0
	},
	low: {
		type: Number,
		default: 0
	},
	high: {
		type: Number,
		default: 0
	},
	firstVolume: {
		type: Number,
		default: 0
	},
	secondVolume: {
		type: Number,
		default: 0
	},
	changePrice: {
		type: Number,
		default: 0
	},
	change: {
		type: Number,
		default: 0
	},
	markupPercentage: {   //a
		type: Number,
		default: 0
	},
	marketPercent: {
		type: Number,
		default: 0
	},
	botstatus: {   //a
		type: String,
		enum: ['off', 'binance', 'bot'],
		default: "off"	// off, binance
	},
	status: {  //a
		type: String,
		enum: ['active', 'deactive'],
		default: "active",  //active, deactive
	},
	isSecondTradeFee: {
		type: String,
		enum: ['ignore', 'not_ignore'],
		default: 'not_ignore'
	},
	last_ask: {
		type: Number,
		default: 0,
	},
	last_bid: {
		type: Number,
		default: 0,
	},
}, {
	timestamps: true
});


const SpotPair = mongoose.model("spotpair", spotPairsSchema, 'spotpair');
export default SpotPair;