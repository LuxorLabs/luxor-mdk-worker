'use strict'

const { DataError } = require('../errors')

const DECIMAL_STRING = /^-?\d+(\.\d+)?$/

function isNumericValue (value) {
  if (typeof value === 'number') {
    return Number.isFinite(value)
  }
  if (typeof value === 'string') {
    // The regex admits digit strings too long for a double, e.g. 400 nines.
    return DECIMAL_STRING.test(value) && Number.isFinite(Number(value))
  }
  return false
}

/**
 * A missing or malformed reading must never become a valid zero.
 * @param {unknown} value number or decimal string
 * @param {string} field  reported in the error message
 * @returns {number}
 */
function toNumber (value, field) {
  if (!isNumericValue(value)) {
    throw new DataError(field)
  }
  return Number(value)
}

module.exports = { toNumber }
