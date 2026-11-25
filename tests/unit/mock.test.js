'use strict'

const test = require('brittle')
const { createServer } = require('../../mock/server')
const keys = require('../../mock/keys')

async function app (t) {
  const { app: server, state } = await createServer({ port: 0 })
  t.teardown(() => server.close())
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

test('mock matches routes by method like fastify did', async t => {
  const { server } = await app(t)
  const url = '/v2/pool/summary/BTC?subaccount_names=mock-sub-1'
  const headers = { authorization: keys.apiKey }
  t.is((await server.inject({ method: 'POST', url, headers })).statusCode, 404)
  t.is((await server.inject({ method: 'DELETE', url, headers })).statusCode, 404)
  const head = await server.inject({ method: 'HEAD', url, headers })
  t.is(head.statusCode, 200)
  t.is(head.body, '')
  t.is((await server.inject({ url, headers })).statusCode, 200)
})

test('mock rejects a repeated scope key like fastify did', async t => {
  const { server } = await app(t)
  const get = url => server.inject({ url, headers: { authorization: keys.apiKey } })
  t.is((await get('/v2/pool/summary/BTC?subaccount_names=mock-sub-1&subaccount_names=mock-sub-2')).statusCode, 400)
  t.is((await get('/v2/pool/workers/BTC?subaccount_names=mock-sub-1&page_size=1&page_size=2')).statusCode, 400)
})
