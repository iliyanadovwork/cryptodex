// import package
import mongoose from 'mongoose';

// import lib
import isEmpty from '../lib/isEmpty.js';

export const priceCNVUpdateValid = (req, res, next) => {
    let errors = {}, reqBody = req.body;

    if (isEmpty(reqBody.priceCNVId)) {
        errors.priceCNVId = "PriceCNVId Field Is Required";
    } else if (!mongoose.Types.ObjectId.isValid(reqBody.priceCNVId)) {
        errors.priceCNVId = "Invalid PriceCNVId";
    }

    if (isEmpty(reqBody.convertPrice)) {
        errors.convertPrice = "ConvertPrice Field Is Required";
    } else if (isNaN(reqBody.convertPrice)) {
        errors.convertPrice = "Only Allow Numeric Value";
    } else if (reqBody.convertPrice <= 0) {
        errors.convertPrice = "Enter Valid ConvertPrice";
    }

   

    if (!isEmpty(errors)) {
        return res.status(400).json({ "errors": errors })
    }

    return next();
}
