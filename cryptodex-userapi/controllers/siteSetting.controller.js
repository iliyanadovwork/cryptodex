// import model
import { SiteSetting } from '../models/index.js';

//import lib
import isEmpty from '../lib/isEmpty.js'

// import config
import config from '../config/index.js';

/**
 * THE SITE SETTING ROW IS BRANDING, AND BRANDING IS STILL LOAD-BEARING.
 * ====================================================================
 * What is gone from this file is the ADMIN half - the multer upload fields, the
 * logo/banner writes, `updateSiteSetting`, `updateSiteDetails`,
 * `updateBannerImage`, `updateUsrDash` and the operator read. Nothing is left
 * to call any of it, and every one of those was a write path with no remaining
 * caller.
 *
 * What is KEPT is the two READS, because the row is consumed in three places
 * that are all still live:
 *
 *   getsiteSetting()  GET /api/user/siteSetting - the frontend fetches this on
 *                     every page (components/HelperRoute.tsx dispatches
 *                     getsiteSetting unconditionally, before login).
 *   getSiteSet()      the gRPC `siteSetting` method in grpc/server.js, which
 *                     spotapi and walletapi call.
 *   ...and controllers/emailTemplate.controller.js reads the same row directly
 *      for the site name, logo and support address stamped into every outbound
 *      e-mail, including the registration and password-reset mails.
 *
 * Deleting the row's readers would therefore have unbranded every e-mail this
 * venue sends, which is why it survives a sweep that removed the rest of the
 * CMS.
 */

/**
 * Get Site Setting (public branding)
 * URL: /api/user/siteSetting
 * METHOD : GET
 *
 * Was controllers/common.controller.getsiteSetting; moved here when
 * common.controller.js - otherwise entirely contact-form, newsletter and
 * slider code - was deleted.
 */
export const getsiteSetting = async (req, res) => {
  try {
    const data = await SiteSetting.findOne({});
    if (data) {
      // The banner fields hold a bare filename; the client needs a URL.
      for (const field of ['bannerImg1', 'bannerImg2', 'bannerImg3', 'bannerImg4']) {
        if (data[field] && !isEmpty(data[field])) {
          data[field] = config.SERVER_URL + '/settings/' + data[field];
        }
      }
    }
    return res
      .status(200)
      .json({ success: true, message: 'Fetch successfully', result: data });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: 'Something went wrong' });
  }
};

/** The gRPC read. spotapi and walletapi call this for site name / logo. */
export const getSiteSet = async () => {
  try {
    let doc = await SiteSetting.findOne({}).lean()

    if (!doc) {
      return {
        'status': false
      }
    }
    return {
      'status': true,
      ...doc
    }
  } catch (err) {
    console.log("----err", err)
    return {
      'status': false
    }
  }
}
