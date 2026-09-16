
// import modal
import {
    Notification
} from '../models/index.js';
import { socketEmitOne, socketEmitAll } from "../config/socketIO.js";
import {
    paginationQuery,
} from "../lib/adminHelpers.js";
/** 
 * Create Notification
 * userId, currencyId, transactionId, trxId, currencySymbol, amount, paymentType,status
*/
export const newNotification = async (doc) => {
    try {
        let newDoc = new Notification(doc)

        await newDoc.save();
        Unreadsocket(doc.userId);
        return { status: true }
    } catch (err) {
        return { status: false }
    }
}

export const Unreadsocket = async (userId) => {

    try {
        var count = await Notification.find({
            userId: userId,
            noti_view_status: false,
        }).countDocuments();
        let notification = await Notification.find({
            userId: userId,
            noti_view_status: false,
        })
            .sort({ createdAt: -1 })
            .limit(5)

        let result = {
            notification: notification,
            count: count
        }
        socketEmitOne("unreadnotification", result, userId);
    } catch (err) {
        console.log(err, "ererere");
    }

};

/**
 * Get Notification History
 * URL : /api/notificationHistory
 * METHOD : GET
 */
export const getNotificationHistory = async (req, res) => {
    try {
        let pagination = paginationQuery(req.query);
        let count = await Notification.countDocuments({ userId: req.user.id });

        Notification.find({
            userId: req.user.id,
        })
            .sort({ createdAt: -1 })
            .limit(pagination.limit)
            .skip(pagination.skip)
            .exec((err, data) => {
                if (err) {
                    return res
                        .status(500)
                        .json({ success: false, message: "Something Wrong" });
                }
                return res.status(200).json({ success: true, result: data, count });
            });
    } catch (err) {
        return res.status(500).json({ success: false, message: "Something Wrong" });
    }
};

/**
* Get Notification History unread
* URL : /api/notificationHistory
* METHOD : GET
*/
export const getUnreadNotification = async (req, res) => {
    try {
        let count = await Notification.countDocuments({ userId: req.user.id, noti_view_status: false, });

        Notification.find({
            userId: req.user.id,
            noti_view_status: false,
        })
            .sort({ createdAt: -1 })
            .limit(5)
            .exec((err, data) => {
                if (err) {
                    return res
                        .status(500)
                        .json({ success: false, message: "Something Wrong" });
                }
                return res.status(200).json({ success: true, result: data, count });
            });
    } catch (err) {
        return res.status(500).json({ success: false, message: "Something Wrong" });
    }
};
/**
* Get Read Notification unread
* URL : /api/notificationHistory
* METHOD : GET
*/
export const getNotificationHistory_read = async (req, res) => {
    var updateVal = {};
    try {
        updateVal.noti_view_status = true;
        await Notification.updateMany(
            { userId: req.user.id },
            { $set: updateVal },
            { new: true }
        )
        return res.status(200).json({ success: true });
    } catch (err) {
        console.log("getNotificationHistory_read", err);
        return res.status(500).json({ success: false, message: "Something Wrong" });
    }

};
