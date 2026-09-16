// import lib
import isEmpty from "./isEmpty";

// Number.prototype.toString() emits exponent notation ("5e-8", "1.2e-7") for
// small/large magnitudes, which the truncation regexes below cannot read - so a
// value could be returned untruncated (or ~1e8 too large) just because it
// printed in exponent form. Every helper normalises through this first.
// Ported from the already-corrected spotapi/lib/roundOf.js.
const plainDecimal = (n) => {
  const s = n.toString();
  if (!/e/i.test(s)) return s;
  if (!Number.isFinite(n) || Math.abs(n) >= 1e21) return s;
  return n.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
};

Number.prototype.toFixedNoRounding = function (n) {
  const reg = new RegExp("^-?\\d+(?:\\.\\d{0," + n + "})?", "g");
  const a = plainDecimal(Number(this)).match(reg)[0];
  const dot = a.indexOf(".");
  if (dot === -1) {
    // integer, insert decimal dot and pad up zeros
    return a + "." + "0".repeat(n);
  }
  const b = n - (a.length - dot) + 1;
  return b > 0 ? a + "0".repeat(b) : a;
};

export const countDecimals = function (value) {
  if (Math.floor(value) === value) return 0;
  return value.toString().split(".")[1].length || 0;
}

export const toFixed = (item, type = 2) => {
  try {
    if (!isEmpty(item) && !isNaN(item)) {
      item = parseFloat(item);
      return item.toFixed(type);
    }
    return "";
  } catch (err) {
    return "";
  }
};

export const priceFixed = (item) => {
  try {
    if (!isEmpty(item) && !isNaN(item)) {
      // `>= 1` (was `> 1`): exactly 1.0 - a pegged/stable pair sitting at par -
      // matched no band and the function fell off the end returning undefined.
      if (item >= 50) return toFixed(item, 2)
      if (item >= 1 && item < 50) return toFixed(item, 3)
      if (item < 1 && item >= 0.1) return longNumbers(item, 4)
      if (item < 0.1 && item >= 0.01) return longNumbers(item, 5)
      if (item < 0.01 && item >= 0.001) return longNumbers(item, 6)
      if (item < 0.001) return longNumbers(item, 7)
    }
    // Anything the ladder does not cover (e.g. a non-finite value that slipped
    // past the guard) gets a defined string rather than undefined.
    return toFixed(item, 2);
  } catch (err) {
    console.log(err);
    return toFixed(item, 2);
  }
}

export const currencyFormat = (item) => {
  try {
    if (!isEmpty(item) && !isNaN(item)) {
      item = item.toString();
      let splitValue = item.split(".");
      return splitValue[1]
        ? `${splitValue[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${splitValue[1]
        }`
        : splitValue[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }
    return "";
  } catch (err) {
    return "";
  }
};

export const randomstring = (x) => {
  try {
    var result = "";
    var characters =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    var charactersLength = characters.length;
    for (var i = 0; i < charactersLength; i++) {
      result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
  } catch (err) {
    return "";
  }
};

export const longNumbers = (x, n) => {
  try {
    if (!isEmpty(x) && !isNaN(x)) {
      x = parseFloat(x)
      if (x < 0) {
        x = x.toFixedNoRounding(n);
        return x
      }
      if (x < 0.000001) {
        return 0.0
      } else if (x > 100) {
        if (n < 2) {
          x = x.toFixedNoRounding(n);
          return x
        }
        x = x.toFixedNoRounding(2);
        return x;
      }
      return x.toFixedNoRounding(n);
    }
    return ""
  } catch (err) {
    console.log('err: ', err);
    return "";
  }
};


export const approxDecimal = (x) => {
  try {
    if (x < 1) {
      if (x < 0.0001) {
        if (x < 0.000001) {
          return 0.0
        }
        return x.toFixedNoRounding(5)
      } else {
        return x.toFixedNoRounding(4)
      }
    } else {
      if (x < 10) {
        return x.toFixedNoRounding(3)
      } else {
        return x.toFixedNoRounding(2)
      }
    }
  } catch (err) {
    return 0
  }
}


// A TRUNCATION HELPER THAT SILENTLY RETURNS A DIFFERENT NUMBER is worse than one
// that returns a slightly wrong one. The old regex `(\d+\.\d{type})(\d)` on
// `item.toString()` had two such traps:
//   - `\d` never matches "-", so a NEGATIVE with more decimals than `type`
//     matched AFTER the sign and returned its MAGNITUDE - a coin down -1.234%
//     rendered as a red "1.23%". The sign is now stripped and re-applied.
//   - exponent notation ("5e-8") the regex cannot read came back untruncated;
//     `plainDecimal` normalises first.
//   - Infinity/NaN (isEmpty & isNaN both let Infinity through) now return "" like
//     every other value this cannot truncate, rather than Infinity.
// Kept in lockstep with spotapi/lib/roundOf.js, which was already corrected.
export const toFixedDown = (item, type = 2) => {
  try {
    if (!isEmpty(item) && !isNaN(item)) {
      item = parseFloat(item);
      if (!Number.isFinite(item)) return "";
      const negative = item < 0;
      const magnitude = Math.abs(item);
      let decReg = new RegExp("(\\d+\\.\\d{" + type + "})(\\d)"),
        m = plainDecimal(magnitude).match(decReg);
      const truncated = m ? parseFloat(m[1]) : magnitude.valueOf();
      return negative ? -truncated : truncated;
    }
    return "";
  } catch (err) {
    return "";
  }
};

export const convert = (n) => {
  try {
    var sign = +n < 0 ? '-' : '',
      toStr = n.toString()
    if (!/e/i.test(toStr)) {
      return n
    }
    var [lead, decimal, pow] = n
      .toString()
      .replace(/^-/, '')
      .replace(/^([0-9]+)(e.*)/, '$1.$2')
      .split(/e|\./)
    return +pow < 0
      ? sign + '0.' + '0'.repeat(Math.max(Math.abs(pow) - 1 || 0, 0)) + lead + decimal
      : sign +
      lead +
      (+pow >= decimal.length
        ? decimal + '0'.repeat(Math.max(+pow - decimal.length || 0, 0))
        : decimal.slice(0, +pow) + '.' + decimal.slice(+pow))
  } catch (err) {
    return 0
  }
}

export const truncateDecimals = (num, decimals) => {
  num = convert(num)
  let
    s = num.toString()
    , p = s.indexOf('.')
    ;
  s += (p < 0 ? (p = 1 + s.length, '.') : '') + '0'.repeat(decimals)
  return s.slice(0, p + 1 + decimals)
}