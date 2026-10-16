'use strict'

const { setTimeout: sleep } = require('node:timers/promises')
const { LuxorApiError } = require('../errors')
const { CURRENCY, DEFAULT_API_URL, PAGE_SIZE, MAX_PAGES, REQUEST_INTERVAL_MS, REQUEST_TIMEOUT_MS } = require('../constants')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HTTP_UNAUTHORIZED = 401

/**
 * Which part of the workspace a request reads. The Luxor API needs exactly
 * one of the two: a list of subaccount names, or a site ID.
 * @typedef {{ subaccounts: string[] } | { siteId: string }} Scope
 */

/**
 * @typedef {Object} LuxorApiOptions
 * @property {string} apiKey
 * @property {string} [apiUrl]            base URL without the /v2 path
 * @property {'BTC'} [currency]
 * @property {AbortSignal} [signal]       aborts waits and in-flight requests
 * @property {number} [requestIntervalMs] minimum spacing between requests
 */

/**
 * Read-only client for the Luxor Pool API v2.
 *
 * Every call goes through one promise chain (`_queue`), so stats, workers
 * and history requests never interleave, and `_waitForRateLimit` spaces
 * consecutive requests by `requestIntervalMs`.
 */
class LuxorApi {
  /**
   * @param {{ get: Function }} http  HttpFacility
   * @param {LuxorApiOptions} options
   */
  constructor (http, options) {
    const { apiUrl = DEFAULT_API_URL, apiKey, currency = CURRENCY, signal, requestIntervalMs = REQUEST_INTERVAL_MS } = options
    LuxorApi.validateConfig({ apiUrl, apiKey, currency })

    this._http = http
    this._baseUrl = apiUrl.replace(/\/+$/, '')
    this._apiKey = apiKey
    this._currency = currency
    this._signal = signal
    this._requestIntervalMs = requestIntervalMs

    this._nextRequestAt = 0
    this._queue = Promise.resolve()
  }

  static validateConfig ({ apiUrl = DEFAULT_API_URL, apiKey, currency = CURRENCY }) {
    if (!isNonEmptyString(apiKey)) {
      throw new Error('ERR_LUXOR_API_KEY_REQUIRED')
    }
    if (currency !== CURRENCY) {
      throw new Error('ERR_LUXOR_CURRENCY_UNSUPPORTED')
    }
    if (!isPlainHttpUrl(apiUrl)) {
      throw new Error('ERR_LUXOR_API_URL_INVALID')
    }
  }

  /**
   * @param {{ subaccounts?: string[], siteId?: string|null }} config
   * @returns {Scope}
   */
  static parseScope ({ subaccounts, siteId }) {
    subaccounts = subaccounts ?? []
    const isList = Array.isArray(subaccounts)
    const allNonEmpty = isList && subaccounts.every(isNonEmptyString)
    const allUnique = isList && new Set(subaccounts).size === subaccounts.length
    if (!allNonEmpty || !allUnique || subaccounts.some(name => name.includes(','))) {
      throw new Error('ERR_LUXOR_SUBACCOUNTS_INVALID')
    }

    const hasSite = siteId !== undefined && siteId !== null
    if (hasSite && !UUID.test(siteId)) {
      throw new Error('ERR_LUXOR_SITE_ID_INVALID')
    }
    if (hasSite === (subaccounts.length > 0)) {
      throw new Error('ERR_LUXOR_SCOPE_REQUIRED')
    }

    return hasSite ? { siteId } : { subaccounts: [...subaccounts] }
  }

  getSummary (scope) {
    return this._request(`/v2/pool/summary/${this._currency}`, scope)
  }

  getWorkers (scope) {
    return this._readPages(`/v2/pool/workers/${this._currency}`, 'workers', scope)
  }

  /**
   * @param {Scope} scope
   * @param {string} startDate YYYY-MM-DD, inclusive
   * @param {string} endDate   YYYY-MM-DD, not later than today
   * @param {'credit'|'debit'} [type]
   */
  getTransactions (scope, startDate, endDate, type) {
    const query = { start_date: startDate, end_date: endDate }
    if (type) {
      query.transaction_type = type
    }
    return this._readPages(`/v2/pool/transactions/${this._currency}`, 'transactions', scope, query)
  }

  /**
   * Drains every page of a paginated endpoint. Luxor marks the last page
   * with `next_page_url: null`.
   */
  async _readPages (path, field, scope, query = {}) {
    const items = []

    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await this._request(path, scope, { ...query, page_number: page, page_size: PAGE_SIZE })
      assertPage(path, field, data, page)
      items.push(...data[field])

      if (data.pagination.next_page_url === null) {
        return items
      }
    }

    throw LuxorApiError.payload(path, 'PAGE_LIMIT')
  }

  _request (path, scope, query = {}) {
    const result = this._queue.then(() => this._send(path, { ...scopeQuery(scope), ...query }))
    // A failed request must not stall the queue for the next caller.
    this._queue = result.catch(() => {})
    return result
  }

  async _send (path, query) {
    this._signal?.throwIfAborted()
    await this._waitForRateLimit()

    let response
    try {
      response = await this._http.get(this._buildUrl(path, query), {
        headers: { Accept: 'application/json', authorization: this._apiKey },
        encoding: 'json',
        timeout: REQUEST_TIMEOUT_MS,
        signal: this._signal,
        redirect: false
      })
    } catch (err) {
      this._signal?.throwIfAborted()
      if (err.status === HTTP_UNAUTHORIZED) {
        throw new Error('ERR_LUXOR_AUTH')
      }
      throw LuxorApiError.transport(path, err)
    }

    const { body } = response
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw LuxorApiError.payload(path, 'INVALID_RESPONSE')
    }
    return body
  }

  async _waitForRateLimit () {
    while (this._nextRequestAt > Date.now()) {
      await sleep(this._nextRequestAt - Date.now(), undefined, { signal: this._signal })
    }
    this._nextRequestAt = Date.now() + this._requestIntervalMs
  }

  _buildUrl (path, query) {
    const search = Object.keys(query).length ? `?${new URLSearchParams(query)}` : ''
    return this._baseUrl + path + search
  }
}

function scopeQuery (scope) {
  return scope.siteId
    ? { site_id: scope.siteId }
    : { subaccount_names: scope.subaccounts.join(',') }
}

function isNonEmptyString (value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isPlainHttpUrl (value) {
  let url
  try {
    url = new URL(value)
  } catch {
    return false
  }
  const isHttp = url.protocol === 'http:' || url.protocol === 'https:'
  const hasExtras = url.username || url.password || url.search || url.hash
  return isHttp && !hasExtras
}

function assertPage (path, field, data, page) {
  const pagination = data.pagination
  const isWellFormed = Array.isArray(data[field]) &&
    pagination && typeof pagination === 'object' &&
    (pagination.next_page_url === null || isNonEmptyString(pagination.next_page_url))
  if (!isWellFormed) {
    throw LuxorApiError.payload(path, 'INVALID_PAGE')
  }

  // The page must echo the request. A repeated page would be counted twice.
  if (pagination.page_number !== page) {
    throw LuxorApiError.payload(path, 'INVALID_PAGE')
  }

  // An empty page that still points to a next page means silent truncation.
  if (pagination.next_page_url !== null && data[field].length === 0) {
    throw LuxorApiError.payload(path, 'INCOMPLETE_PAGE')
  }
}

module.exports = LuxorApi
