// import model
import { Language } from '../models/index.js';

/** 
 * Add Language
 * URL : /adminapi/language
 * METHOD : POST
 * BODY : code, name, isPrimary
*/
export const addLanguage = async (req, res) => {
    try {
        let reqBody = req.body;
        let checkDoc = await Language.findOne({ 'code': reqBody.code });
        if (checkDoc) {
            return res.status(400).json({ 'success': false, 'errors': { "code": "Language code already exists" } })
        }

        if (reqBody.isPrimary == true) {
            await Language.update({}, { "$set": { "isPrimary": false } }, { "multi": true })
        } else {
            let isPrimaryCount = await Language.countDocuments({ 'isPrimary': true })
            if (isPrimaryCount <= 0) {
                reqBody.isPrimary = true
            }
        }

        let newDoc = new Language({
            name: reqBody.name,
            code: reqBody.code,
            isPrimary: reqBody.isPrimary,
        })

        await newDoc.save();
        return res.status(200).json({ 'success': true, 'message': 'Language added successfully' })

    } catch (err) {
        return res.status(500).json({ 'success': false, 'message': 'Something went wrong' })
    }
}

/** 
 * Edit Language
 * URL : /adminapi/language
 * METHOD : PUT
 * BODY : id, code, name, isPrimary, status
*/
export const editLanguage = async (req, res) => {
    try {
        let reqBody = req.body;
        let checkDoc = await Language.findOne({ 'code': reqBody.code, "_id": { "$ne": reqBody.id } });
        if (checkDoc) {
            return res.status(400).json({ 'success': false, 'errors': { "code": "Language code already exists" } })
        }

        if (reqBody.isPrimary == true && reqBody.status == 'active') {
            await Language.update({}, { "$set": { "isPrimary": false } }, { "multi": true })
        } else {
            reqBody.isPrimary = false;
        }

        let languageData = await Language.findOne({ "_id": reqBody.id })
        if (!languageData) {
            return res.status(400).json({ 'success': false, 'message': 'There is no record' })
        }

        if (languageData.isPrimary && (reqBody.isPrimary == false || reqBody.status == 'deactive')) {
            let setPrimary = await Language.findOneAndUpdate({
                "_id": { "$ne": reqBody.id },
                "status": 'active',
            }, { 'isPrimary': true })

            if (!setPrimary) {
                return res.status(400).json({ 'success': false, 'message': 'Does not diable the default language' })
            }
            reqBody.isPrimary = false
        } else if (languageData.status == 'deactive' && reqBody.isPrimary == true && reqBody.status == 'deactive') {
            reqBody.isPrimary = false
        }

        languageData.name = reqBody.name;
        languageData.code = reqBody.code;
        languageData.isPrimary = reqBody.isPrimary;
        languageData.status = reqBody.status;

        await languageData.save();

        return res.status(200).json({ 'success': true, 'message': 'Language updated successfully' })

    } catch (err) {
        return res.status(409).json({ 'success': false, 'message': 'Something went wrong' })
    }
}

/** 
 * Get Language
 * URL : /adminapi/language
 * METHOD : GET
*/
export const languageList = async (_req, res) => {
    Language.find({}, { '_id': 1, 'code': 1, 'name': 1, 'isPrimary': 1, 'status': 1 }, (err, data) => {
        if (err) {
            return res.status(500).json({ 'success': false, 'message': 'Something went wrong' })
        }
        return res.status(200).json({ 'success': true, 'message': 'Fetch successfully', 'result': data })
    })
}

/** 
 * Get Language Dropdown
 * URL : /adminapi/getLanguage
 * METHOD : GET
*/
export const getLanguage = async (_req, res) => {
    Language.find({ 'status': 'active' }, { '_id': 1, 'code': 1, 'name': 1, 'isPrimary': 1, 'status': 1 }, (err, data) => {
        if (err) {
            return res.status(500).json({ 'success': false, 'message': 'Something went wrong' })
        }
        return res.status(200).json({ 'success': true, 'message': 'Fetch successfully', 'result': data })
    })
}