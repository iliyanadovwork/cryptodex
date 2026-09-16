// import package
import mongoose from 'mongoose';
const Schema = mongoose.Schema;
const ObjectId = Schema.ObjectId;

const AssetsSchema = new Schema({
	_id: {
		type: ObjectId,   // Asset unique Id
	},
	currencyId: {
		type: ObjectId,   // Currency Id
		ref: 'currency'
	},
	coin: {
		type: String,
		default: '',
	},
	address: {
		type: String,
		default: '',
	},
	destTag: {
		type: String,   // For XRP Currency
		default: ''
	},
	privateKey: {
		type: String,
		default: '',
	},
	spotBal: {
		type: Number,   // Spot Balance
		default: 0
	},
	spotLockedBal: {
		type: Number,   // Spot Locked Balance
		default: 0
	},
	spotInOrder: {
		type: Number,   // Spot Balance
		default: 0
	},
	erc20BlockNo: {	// Last ERC20 deposit-scan block
		type: Number,
		default: 0
	},
	beb20BlockNo: {	// Last BEP20 deposit-scan block
		type: Number,
		default: 0
	},
	trx20BlockNo: {	// Last TRC20 deposit-scan block
		type: Number,
		default: 0
	},
	poly20BlockNo: {	// Last Polygon deposit-scan block
		type: Number,
		default: 0
	},
	p2pBal: {
		type: Number,
		default: 0
	},
	tokenAddressArray: {
		type: Array,
		default: [],
	},
	blockNo: {
		type: Number,
		default: 0
	}
});


const walletSchema = new Schema({
	_id: {
		type: ObjectId,  // Ref. to user collection _id
		required: true,
		ref: 'user'
	},
	userCode: {
		type: String,
		unique: true,
		required: true
	},
	// gateWayId: {
	// 	type: String,
	// 	default: "",
	// },
	binSubAcctId: {      // Binance Sub Account Id
		type: String,
		default: ''
	},
	// STOOD-DOWN WALLET (see lib/walletStandDown.js for the whole rationale).
	//
	// Set by the `deactivateWallet` gRPC call userapi makes while deactivating
	// an account. It does NOT move, zero or delete a single balance: on a paper
	// exchange there is no custody to return and no fiat rail to close, so the
	// only thing "standing down" can honestly mean is "this wallet may not move
	// value any more". Every money-moving route checks it (see
	// wallet.controller.js#blockFrozenWallet) and refuses.
	//
	// Keeping the balances intact is what makes an operator restore a one-field
	// write rather than a reconstruction, and it keeps the paper ledger
	// auditable. `frozen: false` is the live state, so every wallet that
	// existed before this field did reads as live.
	frozen: {
		type: Boolean,
		default: false
	},
	frozenAt: {
		type: Date,
		default: null
	},
	frozenReason: {
		type: String,
		default: ''
	},
	assets: [AssetsSchema]
}, {
	timestamps: true
});

const wallet = mongoose.model('wallet', walletSchema, 'wallet');

export default wallet;