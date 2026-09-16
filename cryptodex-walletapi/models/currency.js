// import package
import mongoose from 'mongoose';

const Schema = mongoose.Schema;

let CurrencySchema = new Schema({
	name: {
		type: String,
		default: ''
	},
	coin: {
		type: String,
		// unique: true,
		required: true
	},
	symbol: {
		type: String,
		required: true
	},
	gateway_code: {
		type: String,
		required: true
	},
	image: {
		type: String,
		default: ''
	},
	contractDecimal: {
		type: Number,
		default: 0,
	},
	type: {
		type: String,
		enum: ['crypto', 'token', 'fiat'],
		default: 'crypto' // crypto, token, fiat
	},
	withdrawFee: {
		type: Number,   //percentage
		default: 0
	},
	minimumWithdraw: {
		type: Number,
		default: 0
	},
	maximumWithdraw: {
		type: Number,
		default: 0
	},
	minimumDeposit: {
		type: Number,
		default: 0
	},
	maximumDeposit: {
		type: Number,
		default: 0
	},
	bankDetails: {   //fiat
		bankName: {
			type: String,
			default: ""
		},
		accountNo: {
			type: String,
			default: ""
		},
		holderName: {
			type: String,
			default: ""
		},
		bankcode: {
			type: String,
			default: ""
		},
		country: {
			type: String,
			default: ""
		}
	},
	tokenType: {   // token
		type: String,
		enum: ['', 'erc20', 'trc20', 'bep20', 'poly20'],
		default: ''
	},
	minABI: { // token
		type: String,
		default: ''
	},
	contractAddress: { // token
		type: String,
		default: ''
	},
	decimals: { // token
		type: Number,
		default: 0
	},
	isPrimary: {
		type: Boolean,
		default: false
	},
	depositType: {
		type: String,
		enum: ['local', 'coin_payment', 'binance', 'fireblocks', 'none'],
		default: 'local' //'local', 'coin_payment', 'binance', 'none'
	},
	block: {
		type: Number,
		default: 0,
	},
	status: {
		type: String,
		enum: ['active', 'deactive'],
		default: 'active'
	},
	depositStatus: {
		type: String,
		enum: ['active', 'deactive'],
		default: 'active'
	},
	withdrawStatus: {
		type: String,
		enum: ['active', 'deactive'],
		default: 'active'
	},
}, {
	timestamps: true
});

const Currency = mongoose.model('currency', CurrencySchema, 'currency');
export default Currency;