'use strict'

const { DataError } = require('./errors')
const { toNumber } = require('./utils/numbers')
const { CURRENCY, REVENUE_TYPE_MINING } = require('./constants')

/**
 * GET /v2/pool/summary/{currency}. Hashrates arrive as decimal strings in
 * H/s. `hashrate_1h` and the stale hashrates are not in the published
 * schema, so they are read when present and null otherwise.
 */
function parseSummary (summary) {
  if (summary.currency_type !== CURRENCY) {
    throw new DataError('summary.currency_type')
  }

  return {
    hashrate: toNumber(summary.hashrate_5m, 'summary.hashrate_5m'),
    hashrate_1h: optionalNumber(summary.hashrate_1h, 'summary.hashrate_1h'),
    hashrate_24h: toNumber(summary.hashrate_24h, 'summary.hashrate_24h'),
    hashrate_stale_1h: optionalNumber(summary.hashrate_stale_1h, 'summary.hashrate_stale_1h'),
    hashrate_stale_24h: optionalNumber(summary.hashrate_stale_24h, 'summary.hashrate_stale_24h'),
    active_miners: toNumber(summary.active_miners, 'summary.active_miners'),
    efficiency: toNumber(summary.efficiency_5m, 'summary.efficiency_5m'),
    uptime_24h: toNumber(summary.uptime_24h, 'summary.uptime_24h'),
    balance: sumCurrency(summary.balance, 'revenue', 'summary.balance'),
    revenue_24h: sumCurrency(miningOnly(summary.revenue_24h, 'summary.revenue_24h'), 'revenue', 'summary.revenue_24h'),
    revenue_all_time: sumCurrency(miningOnly(summary.revenue_all_time, 'summary.revenue_all_time'), 'revenue', 'summary.revenue_all_time'),
    hashprice: sumCurrency(summary.hashprice, 'value', 'summary.hashprice')
  }
}

function optionalNumber (value, field) {
  return value === undefined || value === null ? null : toNumber(value, field)
}

function miningOnly (entries, field) {
  if (!Array.isArray(entries)) {
    throw new DataError(field)
  }
  return entries.filter(entry => entry?.revenue_type === REVENUE_TYPE_MINING)
}

/**
 * Luxor reports per-currency amounts as arrays. An array without a BTC
 * entry reads as zero; a missing or malformed array fails the poll.
 */
function sumCurrency (entries, key, field) {
  if (!Array.isArray(entries)) {
    throw new DataError(field)
  }
  return entries
    .filter(entry => entry?.currency_type === CURRENCY)
    .reduce((sum, entry) => sum + toNumber(entry[key], `${field}.${key}`), 0)
}

module.exports = { parseSummary }
