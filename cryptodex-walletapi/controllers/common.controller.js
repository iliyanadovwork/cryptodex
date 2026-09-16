// import model
import {
  PriceConversion
} from "../models/index.js";

/**
 * Get Price Conversion
 * URL : /api/priceConversion
 * METHOD : GET
 */
export const getPriceCNV = (req, res) => {
  PriceConversion.find(
    {},
    { _id: 0, baseSymbol: 1, convertSymbol: 1, convertPrice: 1 },
    (err, data) => {
      if (err) {
        return res
          .status(500)
          .json({ success: false, message: "Something went wrong" });
      }
      return res
        .status(200)
        .json({ success: true, message: "Fetch success", result: data });
    }
  );
};