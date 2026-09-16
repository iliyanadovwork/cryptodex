
// import modal
// import {
//     Notification
// } from '../models/index.js';

/** 
 * Create Notification
 * userId, currencyId, transactionId, trxId, currencySymbol, amount, paymentType,status
*/
export const newNotification = async (doc) => {
    try {
        console.log(newDoc, 'newDoc')
        let newDoc = new Notification(doc)

        await newDoc.save();
        return true
    } catch (err) {
        console.log(err, 'err')
        return false
    }
}