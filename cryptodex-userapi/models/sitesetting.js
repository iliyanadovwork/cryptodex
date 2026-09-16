// import package
import mongoose from 'mongoose';
import config from "../config/index.js";
// import lib
import { getTimeStamp } from '../lib/dateHelper.js';

const Schema = mongoose.Schema;
const ObjectId = Schema.ObjectId;

const SiteSettingSchema = new Schema({
    userDashboard: [{
        _id: 0,
        currencyId: {
            type: ObjectId,
        },
        colorCode: {
            type: String,
            default: "",
        }
    }],
    marketTrend: {
        type: [ObjectId],
        default: []
    },
    companyName: {
        type: String,
        default: "",
    },
    siteName: {
        type: String,
        default: "",
    },
    address: {
        type: String,
        default: "",

    },
    contactNo: {
        type: String,
        default: "",

    },
    supportMail: {
        type: String,
        default: "",

    },
    facebookLink: {
        type: String,
        default: "",

    },
    facebookIcon: {
        type: String,
        default: "",
    },
    twitterIcon: {
        type: String,
        default: "",

    },

    twitterUrl: {
        type: String,
        default: "",

    },
    linkedinIcon: {
        type: String,
        default: "",

    },
    telegramLink: {
        type: String,
        default: "",

    },
    instaLink: {
        type: String,
        default: "",

    },
    sitelogo: {
        type: String,
        default: "",

    },
    emailLogo: {
        type: String,
        default: "",

    },
    bannerImg1: {
        type: String,
        default: "",
    },
    bannerImg2: {
        type: String,
        default: "",
    },
    bannerImg3: {
        type: String,
        default: "",
    },
    bannerImg4: {
        type: String,
        default: "",
    },
    binanceDeposit: {
        startTime: {
            type: Number,
            default: getTimeStamp('startTime')
        },
        endTime: {
            type: Number,
            default: getTimeStamp('endTime')
        },
        offest: {
            type: Number,
            default: 0
        },
        limit: {
            type: Number,
            default: 500
        }
    }
})
SiteSettingSchema.virtual("siteLogoUrl").get(function () {
    return this.emailLogo ? `${config.SERVER_URL}/${config.IMAGE.SETTINGS_URL_PATH}/${this.emailLogo}`:"";
});

SiteSettingSchema.set("toJSON", {
    virtuals: true,
});


const SiteSetting = mongoose.model('sitesetting', SiteSettingSchema, 'sitesetting');
export default SiteSetting;