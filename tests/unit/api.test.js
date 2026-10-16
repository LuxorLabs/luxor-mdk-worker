'use strict'

const test = require('brittle')
const { setTimeout: sleep } = require('node:timers/promises')
const LuxorApi = require('../../src/api/client')
const keys = require('../../mock/keys')

const SUBS = { subaccounts: ['sub-1', 'sub-2'] }
const SITE = { siteId: '4c0d1e8a-6f0b-4e7e-9a55-0d4f1b2c3d4e' }

function api (get, opts = {}) {
  return new LuxorApi({ get }, { ...keys, requestIntervalMs: 0, ...opts })
}

function page (field, items, number, next) {
  return { body: { [field]: items, pagination: { page_number: number, page_size: 100, item_count: 0, previous_page_url: null, next_page_url: next } } }
}

test('sends the key in the authorization header and scopes by subaccounts or site', async t => {
  const calls = []
  const client = api(async (url, opts) => {
    calls.push({ url, opts }); return { body: { currency_type: 'BTC' } }
  })
  await client.getSummary(SUBS)
  await client.getSummary(SITE)
  t.is(calls[0].url, 'https://app.luxor.tech/api/v2/pool/summary/BTC?subaccount_names=sub-1%2Csub-2')
  t.is(calls[1].url, `https://app.luxor.tech/api/v2/pool/summary/BTC?site_id=${SITE.siteId}`)
  t.is(calls[0].opts.headers.authorization, keys.apiKey)
  t.is(calls[0].opts.redirect, false, 'authorized requests do not follow redirects')
})

test('reads every page until next_page_url is null', async t => {
  const urls = []
  const client = api(async url => {
    urls.push(url)
    const number = Number(new URL(url).searchParams.get('page_number'))
    return number === 1
      ? page('transactions', [{ id: 1 }], 1, '/next')
      : page('transactions', [{ id: 2 }], 2, null)
  })
  const rows = await client.getTransactions(SUBS, '2026-09-01', '2026-09-22', 'credit')
  t.alike(rows, [{ id: 1 }, { id: 2 }])
  const query = new URL(urls[1]).searchParams
  t.is(query.get('start_date'), '2026-09-01')
  t.is(query.get('end_date'), '2026-09-22')
  t.is(query.get('transaction_type'), 'credit')
  t.is(query.get('page_size'), '100')
})

test('rejects repeated, malformed or truncated pages', async t => {
  await t.exception(api(async () => page('workers', [{}], 2, null)).getWorkers(SUBS), /INVALID_PAGE/)
  await t.exception(api(async () => ({ body: { workers: [] } })).getWorkers(SUBS), /INVALID_PAGE/)
  await t.exception(api(async () => page('workers', [], 1, '/next')).getWorkers(SUBS), /INCOMPLETE_PAGE/)
  await t.exception(api(async () => ({ body: null })).getSummary(SUBS), /INVALID_RESPONSE/)
})

test('401 is an auth error; errors never carry the key or the raw response', async t => {
  const leak = async () => {
    throw Object.assign(new Error(keys.apiKey), { status: 500, response: { key: keys.apiKey } })
  }
  const err = await api(leak).getSummary(SUBS).catch(e => e)
  t.is(err.message, 'ERR_LUXOR_API /v2/pool/summary/BTC 500 REQUEST_FAILED')
  t.absent(JSON.stringify(err).includes(keys.apiKey))
  const auth = await api(async () => {
    throw Object.assign(new Error('no'), { status: 401 })
  }).getSummary(SUBS).catch(e => e)
  t.is(auth.message, 'ERR_LUXOR_AUTH')
})

test('requests are serialized and spaced, and a failure does not stall the queue', async t => {
  const times = []
  let first = true
  const client = api(async () => {
    times.push(Date.now())
    if (first) {
      first = false
      throw new Error('boom')
    }
    return { body: { ok: true } }
  }, { requestIntervalMs: 50 })
  const results = await Promise.allSettled([client.getSummary(SUBS), client.getSummary(SUBS)])
  t.is(results[0].status, 'rejected')
  t.is(results[1].status, 'fulfilled')
  t.ok(times[1] - times[0] >= 45)
})

test('abort cancels the rate-limit wait', async t => {
  const controller = new AbortController()
  const client = api(async () => ({ body: {} }), { requestIntervalMs: 10000, signal: controller.signal })
  await client.getSummary(SUBS)
  const pending = client.getSummary(SUBS)
  await sleep(10)
  controller.abort()
  await t.exception(pending, /abort/i)
})

test('validates config and scope', t => {
  t.exception(() => LuxorApi.validateConfig({}), /ERR_LUXOR_API_KEY_REQUIRED/)
  t.exception(() => LuxorApi.validateConfig({ ...keys, currency: 'ZEC' }), /ERR_LUXOR_CURRENCY_UNSUPPORTED/)
  t.exception(() => LuxorApi.validateConfig({ ...keys, apiUrl: 'https://user:pw@example.com' }), /ERR_LUXOR_API_URL_INVALID/)
  t.exception(() => LuxorApi.parseScope({}), /ERR_LUXOR_SCOPE_REQUIRED/)
  t.exception(() => LuxorApi.parseScope({ subaccounts: ['a'], ...SITE }), /ERR_LUXOR_SCOPE_REQUIRED/)
  t.exception(() => LuxorApi.parseScope({ subaccounts: ['a', 'a'] }), /ERR_LUXOR_SUBACCOUNTS_INVALID/)
  t.exception(() => LuxorApi.parseScope({ subaccounts: ['a,b'] }), /ERR_LUXOR_SUBACCOUNTS_INVALID/)
  t.exception(() => LuxorApi.parseScope({ siteId: 'not-a-uuid' }), /ERR_LUXOR_SITE_ID_INVALID/)
  t.alike(LuxorApi.parseScope({ subaccounts: ['a'], siteId: null }), { subaccounts: ['a'] })
  t.alike(LuxorApi.parseScope(SITE), SITE)
})
