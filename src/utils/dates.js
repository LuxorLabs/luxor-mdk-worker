'use strict'

const { DataError } = require('../errors')
const { DAY_MS } = require('../constants')

function toTimestamp (value, field) {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN
  if (!Number.isFinite(ms)) {
    throw new DataError(field)
  }
  return ms
}

function dateString (time) {
  return new Date(time).toISOString().slice(0, 10)
}

function monthKey (time) {
  const date = new Date(time)
  return `${date.getUTCMonth() + 1}-${date.getUTCFullYear()}`
}

/**
 * The completed UTC day before `time`.
 * @returns {{ start: number, end: number, date: string }} [start, end) in ms and YYYY-MM-DD
 */
function previousDay (time) {
  const end = Date.parse(dateString(time))
  const start = end - DAY_MS
  return { start, end, date: dateString(start) }
}

/**
 * Twelve months ending with the month of `time`, newest first.
 * @returns {Array<{ month: string, start: number }>} `month` is "M-YYYY"
 */
function getMonthlyDateRanges (time) {
  const date = new Date(time)
  return Array.from({ length: 12 }, (_, monthsAgo) => {
    const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - monthsAgo, 1)
    return { month: monthKey(start), start }
  })
}

module.exports = {
  toTimestamp,
  dateString,
  monthKey,
  previousDay,
  getMonthlyDateRanges
}
