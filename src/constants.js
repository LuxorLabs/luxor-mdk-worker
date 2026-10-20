'use strict'

const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

module.exports = {
  CURRENCY: 'BTC',
  POOL_TYPE: 'luxor',
  DEFAULT_API_URL: 'https://app.luxor.tech/api',

  // One request per second per worker, the same pace as the MiningOS worker.
  REQUEST_INTERVAL_MS: SECOND_MS,
  REQUEST_TIMEOUT_MS: 30 * SECOND_MS,
  // The summary's hashrate is a 5 minute average; a metrics pull every few
  // seconds should not cost one API request each.
  SUMMARY_CACHE_MS: 30 * SECOND_MS,
  // Channels are read one after another, so without this a down API would
  // cost one request, and up to one timeout, per channel.
  SUMMARY_ERROR_CACHE_MS: 10 * SECOND_MS,
  PAGE_SIZE: 100,
  MAX_PAGES: 10000,

  DAY_MS,
  STATS_MAX_AGE_MS: 3 * MINUTE_MS,
  HISTORY_TTL_MS: HOUR_MS,

  REVENUE_TYPE_MINING: 'MINING',
  WORKER_STATUS_ACTIVE: 'ACTIVE',
  TRANSACTION_TYPES: { CREDIT: 'credit', DEBIT: 'debit' }
}
