import isEmpty from '../lib/isEmpty.js'
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
  export const stripExponential = (number, precision = 8) => {
    if (isEmpty(number)) return 0
    let float = number.toFixed(precision);
    let precisionIndex = float.match("0*$")["index"];
    return precisionIndex > 2 && !Number.isInteger(Number(float)) ? float.substring(0, precisionIndex) : parseInt(float);
};