import mongoose from "mongoose";

const UserKycSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Types.ObjectId,
        required: true,
        ref: "user",
    },
    level: {
        type: String,
        default: 'Basic'    // Passport, Driving Licence, National Security Card
    },
    idProof: {
        type: {
            type: String,
            default: ''    // Passport, Driving Licence, National Security Card
        },
        proofNumber: {
            type: String,
            default: ''
        },
        country: {
            type: String,
            default: ''
        },
        backImage: {
            type: String,
            default: ''
        },
        selfiImage: {
            type: String,
            default: ''
        },
        frontImage: {
            type: String,
            default: ''
        },
        reason: {
            type: String,
            default: ''
        },
        status: {
            type: String,
            default: 'new'     // new, pending, approved, rejected
        },
    },
    addressProof: {
        type: {
            type: String,
            default: ''    // Passport, Driving Licence, National Security Card
        },
        frontImage: {
            type: String,
            default: ''
        },
        backImage: {
            type: String,
            default: ''
        },
        reason: {
            type: String,
            default: ''
        },
        status: {
            type: String,
            default: 'new'     // new, pending, approved, rejected
        },
    },
    selfiId: {
        frontImage: {
            type: String,
            default: ''
        },
        reason: {
            type: String,
            default: ''
        },
        status: {
            type: Number,
            default: 1     // 1-new, 2-pending, 3-approved, 4-rejected
        },
    },
    bankProof: {
        type: {
            type: String,
            default: 1    // 1-Bank Passbook, 2-Bank statement
        },
        frontImage: {
            type: String,
            default: ''
        },
        reason: {
            type: String,
            default: ''
        },
        status: {
            type: Number,
            default: 1    // 1-new, 2-pending, 3-approved, 4-rejected
        },
    }
}, {
    timestamps: true
})


const KycHistorySchema = new mongoose.Schema({
    userId: {
        type: mongoose.Types.ObjectId,
        required: true,
        // ref: 'user',
    },
    oldKyc: {
        type: UserKycSchema,
        required: true
    },
    reason: {
        type: String,
        required: true,
    },
    status: {
        type: String,
        default: 'rejected'
    }
},
    {
        timestamps: true,
    });



const userHistoryKyc = mongoose.model('userHistoryKyc', KycHistorySchema, 'userHistoryKyc');
export default userHistoryKyc;