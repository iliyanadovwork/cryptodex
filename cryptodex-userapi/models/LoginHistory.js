import mongoose from 'mongoose';
const Schema = mongoose.Schema;
const ObjectId = Schema.ObjectId;

const loginHistorySchema = new Schema({
    userId: {
        type: ObjectId,
        ref: 'users',
    },
    countryCode: {
        type: String,
        default: ''
    },
    countryName: {
        type: String,
        default: ''
    },
    regionName: {
        type: String,
        default: ''
    },
    loginType: {
        type: String,
        default: 'user'
    },
    adminId: {
        type: ObjectId,
        // `default: 'admins'` used to sit here. Mongoose casts defaults, and
        // "admins" is not a 12-byte/24-hex ObjectId, so every document created
        // without an explicit adminId failed validation with
        //   ValidationError: Cast to ObjectId failed for value "admins"
        // It was almost certainly a `ref:` written into the wrong key. There is
        // no `admins` model in this service (the collection is `admin`), and
        // nothing populates this path, so the ref is simply dropped rather than
        // reinstated. Left with no default: absent means absent.
        ref: 'admin'
    },
    ipaddress: {
        type: String,
        default: ''
    },
    broswername: {
        type: String,
        default: ''
    },
    ismobile: {
        type: String,
        default: ''
    },
    os: {
        type: String,
        default: ''
    },
    status: {
        type: String,
        default: 'Success' // success / failure
    },
    reason: {
        type: String,
        default: '' // success / failure
    },
    createdDate: {
        type: Date,
        default: Date.now// success / failure
    }

})

const loginHistoryModel = mongoose.model("loginHistoryModel", loginHistorySchema, "loginHistoryModel");
export default loginHistoryModel;


