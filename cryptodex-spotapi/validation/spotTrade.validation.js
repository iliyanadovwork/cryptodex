// import package
import mongoose from 'mongoose';

// import lib
import isEmpty from '../lib/isEmpty.js';
// ONE DEFINITION OF "IS A NUMBER" ACROSS THIS SERVICE. The
// isEmpty/isNaN/parseFloat trio below used to disagree with itself: `true`
// passed isNaN and then parseFloat'd to NaN, `[50]` became a 50, and "1e309"
// became Infinity. See validation/numericField.validation.js for what each of
// those did downstream.
import { positiveFieldFault } from './numericField.validation.js';

/**
 * Order Place
 * URL : /api/spotOrder
 * METHOD : POST
 * BODY :  token
*/
export const decryptValidate = (req, res, next) => {
    let errors = {}, reqBody = req.body;
    console.log(reqBody, "reqBodyreqBody")
    if (isEmpty(reqBody.token)) {
        errors.token = "REQUIRED";
    }

    if (!isEmpty(errors)) {
        return res.status(400).json({ "errors": errors })
    }

    return next();
}

/**
 * The order types this exchange can actually execute.
 *
 * Exported because controllers/spot.controller.js orderPlace dispatches on
 * exactly this set: one list, so a type can never be accepted here and then
 * find no branch to run.
 */
export const SUPPORTED_ORDER_TYPES = ['limit', 'market'];

/**
 * Types the request vocabulary knows about but the engine does not implement.
 *
 * WHY THEY ARE REFUSED RATHER THAN WIRED UP
 * -----------------------------------------
 * `stop_limit`, `stop_market` and `trailing_stop` used to pass validation, walk
 * into orderPlace, match none of its two branches, and fall off the end of the
 * function - no response was ever written, so the request HUNG until the client
 * timed out and the connection leaked. That is the bug; refusing them is the
 * fix.
 *
 * THE MACHINERY BEHIND THEM IS NOW GONE, not merely disconnected. The three
 * placement handlers, the two triggers that would have fired them
 * (triggerStopLimitOrder / trailingStopOrder), the binance-side stop handlers,
 * their validators, and the order fields they alone used - stopPrice,
 * trailingPrice, distance, conditionalType and the order-level marketPrice -
 * were all deleted. Nothing on this venue can create a conditional order.
 *
 * THIS LIST IS STILL THE CONTRACT, AND MUST STAY. Deleting the machinery does
 * not delete the clients that might still send these strings, and a request
 * naming an order type the engine cannot honour must get a named 400 rather
 * than falling through to the generic "unknown type" path - or worse, being
 * accepted. Cryptodex is a paper-trading exchange; it does not need stop
 * orders, and the one thing it must not do is take a user's funds for one.
 */
export const UNSUPPORTED_ORDER_TYPES = ['stop_limit', 'stop_market', 'trailing_stop'];

/**
 * Order Place
 * URL : /api/spotOrder
 * METHOD : POST
 * BODY :  orderType(limit,market)
*/
export const orderPlaceValidate = (req, res, next) => {
    let errors = {}, reqBody = req.body;
    console.log('-----reqBody.orderType', reqBody.orderType);
    if (isEmpty(reqBody.orderType)) {
        errors.orderType = "REQUIRED";
    } else if (UNSUPPORTED_ORDER_TYPES.includes(reqBody.orderType)) {
        // Distinct from INVALID_ORDER_TYPE on purpose: "we understand what you
        // asked for and do not offer it" is a different fact from "that is not
        // an order type", and a client that cannot tell them apart will retry.
        errors.orderType = "UNSUPPORTED_ORDER_TYPE";
    } else if (!SUPPORTED_ORDER_TYPES.includes(reqBody.orderType)) {
        errors.orderType = "INVALID_ORDER_TYPE";
    }

    if (!isEmpty(errors)) {
        return res.status(400).json({ "errors": errors })
    }

    if (reqBody.orderType == 'limit') {
        return limitOrderValidate(req, res, next)
    } else if (reqBody.orderType == 'market') {
        return marketOrderValidate(req, res, next)
    }

    // UNREACHABLE while this branch list and SUPPORTED_ORDER_TYPES agree, and
    // answered anyway. Falling off the end of a middleware without calling
    // next() or writing a response is exactly how the stop-order types hung,
    // and the shape of that bug must not be able to come back through a list
    // that someone extends without extending the dispatch.
    return res.status(400).json({ errors: { orderType: "UNSUPPORTED_ORDER_TYPE" } })
}

/**
 * Limit order place
 * URL : /api/spotOrder
 * METHOD : POST
 * BODY : spotPairId, price, quantity, buyorsell
*/
export const limitOrderValidate = (req, res, next) => {
    let errors = {}, reqBody = req.body;

    if (isEmpty(reqBody.spotPairId)) {
        errors.spotPairId = "REQUIRED";
    } else if (!mongoose.Types.ObjectId.isValid(reqBody.spotPairId)) {
        errors.spotPairId = "Invalid pair";
    }

    // The three messages are unchanged - only the question behind them is
    // stricter. A boolean, an array, an object and "12abc" are now all
    // "only numeric value" instead of variously becoming NaN, becoming a real
    // number, or being refused by accident.
    const priceFault = positiveFieldFault(reqBody.price);
    if (priceFault === "REQUIRED") {
        errors.price = "Price field is required";
    } else if (priceFault === "NOT_A_NUMBER") {
        errors.price = "Price Value only numeric value";
    } else if (priceFault === "NOT_POSITIVE") {
        errors.price = "Price should be greater than zero";
    }

    const quantityFault = positiveFieldFault(reqBody.quantity);
    if (quantityFault === "REQUIRED") {
        errors.quantity = "Quantity field is required";
    } else if (quantityFault === "NOT_A_NUMBER") {
        errors.quantity = "Quantity Value only numeric value";
    } else if (quantityFault === "NOT_POSITIVE") {
        errors.quantity = "Quantity should be greater than zero";
    }
    if (isEmpty(reqBody.buyorsell)) {
        errors.buyorsell = "REQUIRED";
    } else if (!['buy', 'sell'].includes(reqBody.buyorsell)) {
        errors.buyorsell = "INVALID SIDE";
    }

    if (!isEmpty(errors)) {
        return res.status(400).json({ "errors": errors })
    }

    return next();
}

/**
 * Market order place
 * URL : /api/spotOrder
 * METHOD : POST
 * BODY : spotPairId, quantity, buyorsell
*/
export const marketOrderValidate = (req, res, next) => {
    let errors = {}, reqBody = req.body;
    try {
        if (isEmpty(reqBody.spotPairId)) {
            errors.spotPairId = "REQUIRED";
        } else if (!mongoose.Types.ObjectId.isValid(reqBody.spotPairId)) {
            errors.spotPairId = "Invalid pair";
        }

        if (reqBody.buyorsell == 'buy') {
            // `reqBody.orderValue <= 0` was the old zero test and it is a
            // MIXED-TYPE comparison: "0" <= 0 is true but "-0.5" <= 0 is also
            // reached only after isNaN has let a boolean through. The strict
            // parse answers all three questions with one definition of "number".
            const valueFault = positiveFieldFault(reqBody.orderValue);
            if (valueFault === "REQUIRED") {
                errors.orderValue = "Order Value field is Required"
            } else if (valueFault === "NOT_A_NUMBER") {
                errors.orderValue = "Order Value only numeric value"
            } else if (valueFault === "NOT_POSITIVE") {
                errors.orderValue = "Order Value should be greater than zero"
            }
        } else if (reqBody.buyorsell == 'sell') {
            const amountFault = positiveFieldFault(reqBody.amount);
            if (amountFault === "REQUIRED") {
                errors.amount = "Quantity field is Required"
            } else if (amountFault === "NOT_A_NUMBER") {
                errors.amount = "Quantity only numeric value"
            } else if (amountFault === "NOT_POSITIVE") {
                errors.amount = "Quantity should be greater than zero"
            }
        }

        if (isEmpty(reqBody.buyorsell)) {
            errors.buyorsell = "REQUIRED";
        } else if (!['buy', 'sell'].includes(reqBody.buyorsell)) {
            errors.buyorsell = "INVALID SIDE";
        }
        console.log('---errors', errors);
        if (!isEmpty(errors)) {
            return res.status(400).json({ "errors": errors })
        }

        return next();
    } catch (err) {
        console.log('err: ', err);

    }

}
