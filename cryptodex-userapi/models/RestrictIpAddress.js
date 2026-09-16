import mongoose from 'mongoose';
const Schema = mongoose.Schema;

let ipAddressSchema = new Schema(
  {
    ip: {
      type: String,
    },
  },

  {
    timestamps: true,
  }
);

const ipAddress = mongoose.model("restrictedIp", ipAddressSchema, "restrictedIp");
export default ipAddress;
