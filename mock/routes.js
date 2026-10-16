'use strict'

const { timingSafeEqual } = require('node:crypto')
const keys = require('./keys')

const PREFIX = '/v2/pool'
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const DEFAULT_PAGE_SIZE = 10
const MAX_PAGE_SIZE = 1000
const TRANSACTION_TYPES = ['credit', 'debit']

const badRequest = (reply, message) => reply.code(400).send({ statusCode: 400, error: 'Bad Request', message })

/**
 * Minimal Luxor Pool API v2 mock, shaped after the published OpenAPI spec.
 *
 * It checks the `authorization` key, requires exactly the scope the real
 * API requires (`subaccount_names` or `site_id`), rejects subaccounts the
 * workspace does not own, paginates with `next_page_url`, and rejects an
 * `end_date` after today.
 *
 * Options:
 *   state  workspace data, see mock/state.js
 */
module.exports = async (app, { state }) => {
  app.addHook('preHandler', async (request, reply) => {
    if (!isAuthentic(request.headers.authorization)) {
      return reply.code(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Invalid API key' })
    }
    if (request.params.currency_type !== 'BTC') {
      return badRequest(reply, 'Unsupported currency_type')
    }

    const scope = resolveScope(state, request.query)
    if (scope === null) {
      return badRequest(reply, 'Provide one or more subaccount names or a site id')
    }
    if (scope === false) {
      return reply.code(403).send({ statusCode: 403, error: 'Forbidden', message: 'Subaccount or site not in workspace' })
    }
    request.scope = scope
  })

  app.get(`${PREFIX}/summary/:currency_type`, async request => ({
    currency_type: 'BTC',
    subaccounts: state.subaccounts.filter(sub => request.scope.has(sub.name)),
    ...state.summary
  }))

  app.get(`${PREFIX}/workers/:currency_type`, async (request, reply) => {
    const page = parsePage(request.query)
    if (!page) {
      return badRequest(reply, 'Invalid pagination')
    }

    const rows = state.workers.filter(worker => request.scope.has(worker.subaccount_name))
    return {
      currency_type: 'BTC',
      subaccounts: state.subaccounts.filter(sub => request.scope.has(sub.name)),
      total_active: rows.filter(worker => worker.status === 'ACTIVE').length,
      total_inactive: rows.filter(worker => worker.status === 'INACTIVE').length,
      workers: paginate(rows, page),
      pagination: pagination(request, rows.length, page)
    }
  })

  app.get(`${PREFIX}/transactions/:currency_type`, async (request, reply) => {
    const page = parsePage(request.query)
    const { start_date: start, end_date: end, transaction_type: type } = request.query
    const today = new Date().toISOString().slice(0, 10)

    const validRange = ISO_DATE.test(start) && ISO_DATE.test(end) && start <= end
    if (!page || !validRange || (type !== undefined && !TRANSACTION_TYPES.includes(type))) {
      return badRequest(reply, 'Invalid query')
    }
    if (end > today) {
      return badRequest(reply, 'end_date must not be in the future')
    }

    const rows = state.transactions.filter(row => {
      const date = row.date_time.slice(0, 10)
      return request.scope.has(row.subaccount_name) &&
        date >= start && date <= end &&
        (type === undefined || row.transaction_type === type)
    })
    return {
      transactions: paginate(rows, page),
      pagination: pagination(request, rows.length, page)
    }
  })
}

function isAuthentic (header) {
  if (typeof header !== 'string') {
    return false
  }
  const given = Buffer.from(header)
  const expected = Buffer.from(keys.apiKey)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/**
 * @returns {Set<string>|null|false} subaccount names in scope; null when the
 *   query names no scope; false when it names one outside the workspace
 */
function resolveScope (state, { subaccount_names: names, site_id: siteId }) {
  const hasNames = typeof names === 'string' && names.length > 0
  const hasSite = typeof siteId === 'string' && siteId.length > 0
  if (hasNames === hasSite) {
    return null
  }

  if (hasSite) {
    if (siteId !== state.siteId) {
      return false
    }
    return new Set(state.subaccounts.filter(sub => sub.site?.id === siteId).map(sub => sub.name))
  }

  const requested = names.split(',')
  const owned = new Set(state.subaccounts.map(sub => sub.name))
  return requested.every(name => owned.has(name)) ? new Set(requested) : false
}

function parsePage ({ page_number: number = '1', page_size: size = String(DEFAULT_PAGE_SIZE) }) {
  const page = { number: Number(number), size: Number(size) }
  const isValid = Number.isInteger(page.number) && page.number >= 1 &&
    Number.isInteger(page.size) && page.size >= 1 && page.size <= MAX_PAGE_SIZE
  return isValid ? page : null
}

function paginate (rows, { number, size }) {
  return rows.slice((number - 1) * size, number * size)
}

function pagination (request, total, { number, size }) {
  const link = pageNumber => {
    const url = new URL(request.url, 'http://mock.invalid')
    url.searchParams.set('page_number', String(pageNumber))
    return url.pathname + url.search
  }
  return {
    page_number: number,
    page_size: size,
    item_count: total,
    previous_page_url: number > 1 ? link(number - 1) : null,
    next_page_url: number * size < total ? link(number + 1) : null
  }
}
