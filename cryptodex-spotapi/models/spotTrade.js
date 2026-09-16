// import package
import mongoose from 'mongoose';

const Schema = mongoose.Schema;
const ObjectId = Schema.ObjectId;

const filledSchema = new Schema({
	pairId: {
		type: ObjectId,
		ref: 'spotpairs',
	},
	userId: {
		type: ObjectId,
		ref: 'users'
	},
	buyUserId: {
		type: ObjectId,
		ref: 'users'
	},
	sellUserId: {
		type: ObjectId,
		ref: 'users'
	},
	sellOrderId: {
		type: ObjectId,
		ref: 'spottradeTable'
	},
	buyOrderId: {
		type: ObjectId,
		ref: 'spottradeTable'
	},
	uniqueId: {
		type: String,
		default: 0
	},
	price: {
		type: Number,
		default: 0
	},
	filledQuantity: {
		type: Number,
		default: 0
	},
	orderValue: {
		type: Number,
		default: 0
	},
	Type: {
		type: String
	},
	Fees: {
		type: Number,
		default: 0
	},
	isMaker: {
		type: Boolean,
		default: false
	},
	createdAt: {
		type: Date,
		default: Date.now
	},
	userCode: {
        type: String,
        default: "",
    },
	/* ----------------------------- */
	"filledAmount": Number,
	"pairName": {
		type: String,
	},
	"firstCurrency": { type: String, default: '', index: true },
	"secondCurrency": { type: String, default: '', index: true },
	"status": { type: String, index: true },
	beforeBalance: { type: String, default: 0 },
	afterBalance: { type: String, default: 0 },


});


const SpotOrderSchema = new Schema({
	userId: {
		type: ObjectId,
		required: true,
		ref: 'users'
	},
	pairId: {
		type: ObjectId,
		required: true,
		ref: 'spotpairs'
	},
	pairName: {
		type: String,
		required: true,
		default: ''
	},
	firstCurrencyId: {
		type: ObjectId,
		required: true,
		ref: 'currency'
	},
	firstCurrency: {
		type: String,
		required: true,
		default: '',
	},
	secondCurrencyId: {
		type: ObjectId,
		required: true,
		ref: 'currency'
	},
	secondCurrency: {
		type: String,
		required: true,
		default: '',
	},
	buyorsell: {
		type: String,
		default: ''     //buy or sell
	},
	orderType: {
		type: String,
		enum: ['limit', 'market'],
	},
	price: {
		type: Number,
		default: 0
	},
	quantity: {
		type: Number,
		required: true,
		default: 0
	},
	filledQuantity: {
		type: Number,
		default: 0
	},
	orderValue: {
		type: Number,
		default: ''
	},
	beforeBalance: {
		type: String,
		default: 0
	},
	afterBalance: {
		type: String,
		default: 0
	},
	orderDate: {
		type: Date,
		default: Date.now
	},
	liquidityId: {
		type: String,
		default: ""
	},
	liquidityType: {
		type: String,
		enum: ['local', 'binance', 'admin'],
		default: 'local'
	},
	isLiquidity: {
		type: Boolean,
		default: false
	},
	isLiquidityError: {
		type: Boolean,
		default: false
	},
	filled: [filledSchema],
	status: {
		type: String,
		required: true,
		enum: ['open', 'pending', 'completed', 'cancel', 'conditional'],
		default: 'open', //0-new, 1-completed, 2-partial, 3- Cancel, 4- Conditional
	},
	markuppercentage: {
		type: String,
		default: ''   //mark price
	},

}, {
	timestamps: true
});

const SpotOrder = mongoose.model('spotOrder', SpotOrderSchema, 'spotOrder');
export default SpotOrder;