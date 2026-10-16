'use strict'

const test = require('brittle')
const fastify = require('fastify')
const routes = require('../../mock/routes')
const defaultState = require('../../mock/state')
const keys = require('../../mock/keys')

async function app (t) {
  const server = fastify()
  t.teardown(() => server.close())
  const state = defaultState()
  server.register(routes, { state })
  return { server, state }
}

test('mock enforces the key, the scope and workspace ownership', async t => {
  const { server, state } = await app(t)
  const get = (url, authorization = keys.apiKey) => server.inject({ url, headers: { authorization } })
  t.is((await get('/v2/pool/summary/BTC?subaccount_names=mock-sub-1', 'wrong')).statusCode, 401)
  t.is((await get('/v2/pool/summary/BTC')).statusCode, 400)
  t.is((await get('/v2/pool/summary/BTC?subaccount_names=mock-sub-1')).statusCode, 200)
  t.is((await get(`/v2/pool/summary/BTC?site_id=${state.siteId}`)).statusCode, 200)
  t.is((await get('/v2/pool/summary/BTC?subaccount_names=someone-else')).statusCode, 403)
  t.is((await get('/v2/pool/summary/LTC_DOGE?subaccount_names=mock-sub-1')).statusCode, 400)
})

test('mock paginates and rejects a future end_date', async t => {
  const { server } = await app(t)
  const get = url => server.inject({ url, headers: { authorization: keys.apiKey } })
  const first = (await get('/v2/pool/workers/BTC?subaccount_names=mock-sub-1,mock-sub-2&page_size=1')).json()
  t.is(first.workers.length, 1)
  t.ok(first.pagination.next_page_url.includes('page_number=2'))
  const last = (await get('/v2/pool/workers/BTC?subaccount_names=mock-sub-1,mock-sub-2&page_size=1&page_number=2')).json()
  t.is(last.pagination.next_page_url, null)
  t.is((await get('/v2/pool/transactions/BTC?subaccount_names=mock-sub-1&start_date=2026-01-01&end_date=2999-01-01')).statusCode, 400)
})
