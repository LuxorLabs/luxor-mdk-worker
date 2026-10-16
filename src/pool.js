'use strict'

const { PoolService } = require('./mdk')
const LuxorApi = require('./api/client')
const { DataError } = require('./errors')
const { toNumber } = require('./utils/numbers')
const { toTimestamp, dateString, monthKey, previousDay, getMonthlyDateRanges } = require('./utils/dates')
const { getWorkersStats } = require('./utils/workers')
const { CURRENCY, POOL_TYPE, DEFAULT_API_URL, HISTORY_TTL_MS, STATS_MAX_AGE_MS, REQUEST_INTERVAL_MS, REVENUE_TYPE_MINING, TRANSACTION_TYPES } = require('./constants')

const DAILY_JOB = '1D'
const MONTHS_OF_HISTORY = 12

const toSecondTs = time => Math.floor(time.getTime() / 1000) * 1000

/**
 * @typedef {Object} ScopeStats
 * @property {string} username           comma-separated subaccounts, or "site:<id>"
 * @property {number} timestamp          ms when the snapshot was taken
 * @property {number} balance            BTC
 * @property {null} unsettled            the API does not expose pending payouts
 * @property {number} revenue_24h        BTC mining revenue over the last 24 hours
 * @property {number} estimated_today_income  same as revenue_24h
 * @property {number} hashrate           H/s, 5 minute average
 * @property {number|null} hashrate_1h   H/s, null when the API omits it
 * @property {number} hashrate_24h       H/s
 * @property {number|null} hashrate_stale_1h  H/s, null when the API omits it
 * @property {number|null} hashrate_stale_24h H/s, null when the API omits it
 * @property {number} worker_count       workers in the last worker poll
 * @property {number} active_workers_count active miners from the summary
 * @property {number} efficiency         5 minute share efficiency, 0 to 1
 * @property {number} uptime_24h         0 to 1
 * @property {number} hashprice          BTC per TH/s per day
 * @property {number} revenue_all_time   BTC mining revenue
 * @property {MonthlyBalance[]} yearlyBalances
 */

/**
 * @typedef {Object} MonthlyBalance
 * @property {string} month   "M-YYYY"
 * @property {number} balance BTC mining revenue credited in that month
 */

/**
 * @typedef {Object} LedgerTransaction
 * @property {string} username         subaccount name
 * @property {string} id               Luxor transaction ID
 * @property {'credit'|'debit'} type
 * @property {string} category         e.g. "Miner Revenue"
 * @property {number} changed_balance  BTC, always positive; `type` gives the direction
 * @property {number} created_at       unix seconds
 */

/**
 * Luxor Bitcoin pool worker.
 *
 * The configured subaccounts (or site) form one scope, and the Luxor API
 * aggregates across it, so each stats poll is one summary request. Two
 * mechanisms keep slow polls from piling up:
 *  - `LuxorApi` serializes all HTTP calls through one queue;
 *  - `_dedupe` makes overlapping scheduler ticks share one in-flight job.
 */
class LuxorPool extends PoolService {
  constructor (conf, ctx) {
    super({ ...conf, wtype: conf?.wtype || POOL_TYPE }, ctx)
    this._inFlight = new Map()
    this._yearlyBalances = null
    this._statsError = null
  }

  async init () {
    if (this._initialized) {
      return
    }

    try {
      await super.init(POOL_TYPE)
      this._scheduleDailyJobInUtc()
    } catch (err) {
      await new Promise(resolve => this.stop(resolve))
      throw err
    }
  }

  /**
   * PoolService schedules the daily job in local time. Ledger days are
   * keyed by UTC, so the job fires at UTC midnight.
   */
  _scheduleDailyJobInUtc () {
    this.scheduler_0.del(DAILY_JOB)
    this.scheduler_0.add(
      DAILY_JOB,
      time => this.fetchData(DAILY_JOB, time),
      { rule: '0 0 0 * * *', tz: 'Etc/UTC' }
    )
  }

  async _createFacilities (ctx) {
    const config = this.conf.luxor || {}

    this.scope = LuxorApi.parseScope(config)
    LuxorApi.validateConfig(config)

    await super._createFacilities(ctx)

    this.luxorApi = new LuxorApi(this.http_0, {
      ...config,
      signal: this.abortSignal,
      requestIntervalMs: process.env.NODE_ENV === 'test' ? 0 : REQUEST_INTERVAL_MS
    })
  }

  /**
   * PoolService registers signal handlers it never removes. Keep a reference
   * so stop() can detach them and a test process does not leak listeners.
   */
  _bindProcessExit () {
    this._onProcessExit = () => this.stop(() => {})
    process.once('SIGINT', this._onProcessExit)
    process.once('SIGTERM', this._onProcessExit)
  }

  stop (cb) {
    if (this._onProcessExit) {
      process.removeListener('SIGINT', this._onProcessExit)
      process.removeListener('SIGTERM', this._onProcessExit)
    }
    super.stop(cb)
  }

  getHttpUrl () {
    return this.conf.luxor?.apiUrl || DEFAULT_API_URL
  }

  get username () {
    return this.scope.siteId ? `site:${this.scope.siteId}` : this.scope.subaccounts.join(',')
  }

  fetchStats (time) {
    return this._dedupe('stats', async () => {
      try {
        const summary = parseSummary(await this.luxorApi.getSummary(this.scope))
        const yearlyBalances = await this.getYearlyBalances(time)
        const stats = [{
          username: this.username,
          timestamp: Date.now(),
          balance: summary.balance,
          unsettled: null,
          revenue_24h: summary.revenue_24h,
          estimated_today_income: summary.revenue_24h,
          hashrate: summary.hashrate,
          hashrate_1h: summary.hashrate_1h,
          hashrate_24h: summary.hashrate_24h,
          hashrate_stale_1h: summary.hashrate_stale_1h,
          hashrate_stale_24h: summary.hashrate_stale_24h,
          worker_count: this.data.workersData.workers.length,
          active_workers_count: summary.active_miners,
          efficiency: summary.efficiency,
          uptime_24h: summary.uptime_24h,
          hashprice: summary.hashprice,
          revenue_all_time: summary.revenue_all_time,
          yearlyBalances
        }]
        this.data.statsData = { ts: toSecondTs(time), stats }
        this._statsError = null
      } catch (err) {
        this._statsError = err
        throw err
      }
    })
  }

  fetchWorkers (time) {
    return this._dedupe('workers', async () => {
      const workers = getWorkersStats(await this.luxorApi.getWorkers(this.scope))
      const active = workers.filter(worker => worker.online).length

      const ts = toSecondTs(time)
      await this._saveToDb(this.workersCountDb, ts, { ts, count: workers.length, active, inactive: workers.length - active })
      this.data.workersData = { ts, workers }
    })
  }

  /**
   * Fires at UTC midnight and stores the ledger rows of the day that just
   * ended, credits and debits both.
   * @param {Date} [time] scheduler fire time; the previous UTC day is collected
   */
  fetchTransactions (time = new Date()) {
    return this._dedupe('transactions', async () => {
      const day = previousDay(time)
      const rows = await this.luxorApi.getTransactions(this.scope, day.date, dateString(day.end))

      const transactions = []
      for (const row of rows) {
        const transaction = toLedgerTransaction(row)
        const createdAt = transaction.created_at * 1000
        if (createdAt >= day.start && createdAt < day.end) {
          transactions.push(transaction)
        }
      }

      await this._saveToDb(this.transactionsDb, day.start, { ts: day.start, transactions })
    })
  }

  /**
   * Mining revenue credited per month for the last twelve months, newest
   * first. Cached for HISTORY_TTL_MS and refreshed on month rollover.
   * @returns {Promise<MonthlyBalance[]>}
   */
  getYearlyBalances (time = new Date()) {
    return this._dedupe('history', async () => {
      const ranges = getMonthlyDateRanges(time)
      const cached = this._yearlyBalances
      if (isFreshHistory(cached, ranges[0].month)) {
        return cached.balances
      }

      const balances = await this._fetchMonthlyRevenue(ranges, time)
      this._yearlyBalances = { month: ranges[0].month, ts: Date.now(), balances }
      return balances
    })
  }

  /**
   * One stats field for the configured scope. Throws E_POOL_API when the
   * last poll failed, is older than STATS_MAX_AGE_MS, or lacks the field.
   * @param {string} field key of an entry in `data.statsData.stats`
   * @returns {number}
   */
  getMetric (field) {
    const { ts, stats } = this.data.statsData

    const isStale = Date.now() - ts > STATS_MAX_AGE_MS
    if (this._statsError || !stats?.length || isStale) {
      throw new Error('E_POOL_API: Luxor statistics are unavailable or stale')
    }
    if (stats.some(entry => !Number.isFinite(entry[field]))) {
      throw new Error(`E_POOL_API: Luxor ${field} is unavailable`)
    }

    return stats.reduce((sum, entry) => sum + entry[field], 0)
  }

  /**
   * The base class sums `satoshis_net_earned`, which Luxor rows do not
   * carry. Mining revenue here is the sum of credited amounts; debits are
   * payouts and fees, not negative revenue.
   */
  _aggrTransactions (data, range) {
    const credits = data.map(log => ({
      transactions: (log.transactions || [])
        .filter(row => row.type === TRANSACTION_TYPES.CREDIT)
        .map(row => ({ satoshis_net_earned: Math.round(row.changed_balance * 1e8) }))
    }))
    return super._aggrTransactions(credits, range)
  }

  async _fetchMonthlyRevenue (ranges, time) {
    const oldest = ranges[MONTHS_OF_HISTORY - 1]
    // The API rejects an end_date after today.
    const rows = await this.luxorApi.getTransactions(this.scope, dateString(oldest.start), dateString(time), TRANSACTION_TYPES.CREDIT)

    const totals = new Map(ranges.map(range => [range.month, 0]))
    for (const row of rows) {
      const transaction = toLedgerTransaction(row)
      const month = monthKey(transaction.created_at * 1000)
      if (transaction.type === TRANSACTION_TYPES.CREDIT && totals.has(month)) {
        totals.set(month, totals.get(month) + transaction.changed_balance)
      }
    }

    return Array.from(totals, ([month, balance]) => ({ month, balance }))
  }

  /**
   * Callers with the same key share the job that is already running.
   * @param {string} key job identity, e.g. 'stats' or 'history'
   * @param {() => Promise<T>} job
   * @returns {Promise<T>}
   * @template T
   */
  _dedupe (key, job) {
    if (this._inFlight.has(key)) {
      return this._inFlight.get(key)
    }

    const pending = Promise.resolve()
      .then(job)
      .finally(() => this._inFlight.delete(key))
    this._inFlight.set(key, pending)
    return pending
  }
}

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

/** @returns {LedgerTransaction} */
function toLedgerTransaction (row) {
  const isKnownType = Object.values(TRANSACTION_TYPES).includes(row?.transaction_type)
  if (!isKnownType || typeof row.transaction_id !== 'string') {
    throw new DataError('transaction')
  }
  if (row.currency_type !== CURRENCY) {
    throw new DataError('transaction.currency_type')
  }

  return {
    username: row.subaccount_name,
    id: row.transaction_id,
    type: row.transaction_type,
    category: row.transaction_category,
    changed_balance: toNumber(row.currency_amount, 'transaction.currency_amount'),
    created_at: Math.floor(toTimestamp(row.date_time, 'transaction.date_time') / 1000)
  }
}

function isFreshHistory (cached, currentMonth) {
  return Boolean(cached) &&
    cached.month === currentMonth &&
    Date.now() - cached.ts < HISTORY_TTL_MS
}

module.exports = LuxorPool
