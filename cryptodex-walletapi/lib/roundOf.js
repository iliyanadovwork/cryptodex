// import lib
import isEmpty from './isEmpty.js';

export const toFixed = (item, type = 2) => {
    try {
        if (!isEmpty(item) && !isNaN(item)) {
            item = parseFloat(item)
            item = item.toFixed(type)
            return parseFloat(item)
        }
        return ''
    } catch (err) {
        return ''
    }
}

export const toFixedDown = (item, digits = 2) => {
    try {
      if (!isEmpty(item) && !isNaN(item)) {
        let multiplier = Math.pow(10, digits),
          adjustedNum = item * multiplier,
          truncatedNum = Math[adjustedNum < 0 ? "ceil" : "floor"](adjustedNum);
        let res=truncatedNum / multiplier
        return parseFloat(res.toFixed(digits));
      }
      return "";
    } catch (err) {
      console.log("toFixedDowntoFixedDown_err", err)
      return "";
    }
  };