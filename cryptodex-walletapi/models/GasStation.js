import mongoose from 'mongoose';

const GasStationAssetSchema = new mongoose.Schema(
  {
    assetId: {
      type: String,
      required: true
    },
    currencyId: {
      type: String,
      required: true,
      ref: 'currency'
    },
    symbol: {
      type: String,
      required: true
    },
    address: {
      type: String,
      required: true
    },
    balance: {
      type: Number,
      required: true
    }
  },
  { timestamps: true }
);

const GasStationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true
    },
    assets: [GasStationAssetSchema],
    vaultId: {
      type: String,
      default: '0'
    }
  },
  { timestamps: true }
);

const GasStation = mongoose.model('gasStation', GasStationSchema, 'gasStation');
export default GasStation;
