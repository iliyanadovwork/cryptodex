// import package
import mongoose from 'mongoose';

// import helpers
import isEmpty, { isBoolean } from '../lib/isEmpty.js';

/** 
 * Add Language
 * URL : /adminapi/language
 * METHOD : POST
 * BODY : name, code, isPrimary
*/
export const addLangValidate = (req, res, next) => {
    let errors = {}, reqBody = req.body;

    if (isEmpty(reqBody.name)) {
        errors.name = "Name field is required";
    }

    if (isEmpty(reqBody.code)) {
        errors.code = "Code field is required";
    }

    if (isEmpty(reqBody.isPrimary)) {
        errors.isPrimary = "Primary field is required";
    } else if (!isBoolean(reqBody.isPrimary)) {
        errors.isPrimary = "Primary field is required";
    }

    if (!isEmpty(errors)) {
        return res.status(400).json({ "errors": errors })
    }

    return next();
}

/** 
 * Edit Language
 * URL : /adminapi/language
 * METHOD : PUT
 * BODY : id, name, code, isPrimary, status
*/
export const editLangValidate = (req, res, next) => {
    let errors = {}, reqBody = req.body;

    if (isEmpty(reqBody.id)) {
        errors.id = "Language Id field is required";
    } else if (!(mongoose.Types.ObjectId.isValid(reqBody.id))) {
        errors.id = "ID is invalid";
    }

    if (isEmpty(reqBody.name)) {
        errors.name = "Language field is required";
    }
    
    if (isEmpty(reqBody.code)) {
        errors.code = "Code field is required";
    }

    if (isEmpty(reqBody.isPrimary)) {
        errors.isPrimary = "Primary field is required";
    } else if (!isBoolean(reqBody.isPrimary)) {
        errors.isPrimary = "Primary field is required";
    }

    if (isEmpty(reqBody.status)) {
        errors.status = "Status field is required";
    } else if (!['active','deactive'.includes(reqBody.status)]) {
        errors.status = "Status type is invalid";
    }
 
    if (!isEmpty(errors)) {
        return res.status(400).json({ "errors": errors })
    }

    return next();
}