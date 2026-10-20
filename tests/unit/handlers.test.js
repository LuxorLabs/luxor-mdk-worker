'use strict'

const test = require('brittle')
const path = require('node:path')
const { loadContract, createInstance } = require('@tetherto/mdk/backend/core/mdk-worker')
const { createServer } = require('../../mock/server')
const keys = require('../../mock/keys')

const PKG_DIR = path.join(__dirname, '..', '..')
const SUBACCOUNTS = ['mock-sub-1', 'mock-sub-2']

function instance (opts, id = 'luxor-0') {
  return createInstance({ dir: PKG_DIR, entries: loadContract(PKG_DIR).entries, device: { id, opts, env: {}, config: {} } })
}

async function mock (t) {
  const server = await createServer({ port: 0 })
  t.teardown(() => server.app.close())
  return server
}

const metrics = async (inst) => {
  const out = {}
  await Promise.all([...inst.telemetry].map(async ([name, fn]) => {
    try { out[name] = await fn({}) } catch (err) { out[name] = { error: err.message } }
  }))
  return out
}

test('every contract channel reads the pool summary, scoped by subaccounts or site', async t => {
  const server = await mock(t)
  for (const scope of [{ subaccounts: SUBACCOUNTS }, { siteId: server.state.siteId }]) {
    const inst = instance({ apiKey: keys.apiKey, apiUrl: server.apiUrl, ...scope })
    t.is(await inst.telemetry.get('hashrate')({}), 150e12)
    t.is(await inst.telemetry.get('workers_online')({}), 1)
    t.is(await inst.telemetry.get('balance')({}), 0.00125)
    t.is(await inst.telemetry.get('estimated_earnings')({}), 0.00012, 'mining revenue only, referral excluded')
  }
})

test('a metrics pull costs one API request, not one per channel', async t => {
  const server = await mock(t)
  const inst = instance({ apiKey: keys.apiKey, apiUrl: server.apiUrl, subaccounts: SUBACCOUNTS })
  await metrics(inst)
  await metrics(inst)
  t.is(server.requests.filter(url => url.includes('/summary/')).length, 1)
})

test('a failing API is asked once per pull, also when channels are read one by one', async t => {
  const server = await mock(t)
  const inst = instance({ apiKey: 'wrong-key', apiUrl: server.apiUrl, subaccounts: SUBACCOUNTS }, 'luxor-failing')
  for (const [, fn] of inst.telemetry) await fn({}).catch(() => {})
  t.is(server.requests.filter(url => url.includes('/summary/')).length, 1)
  await t.exception(inst.telemetry.get('hashrate')({}), /ERR_LUXOR_AUTH/, 'the cached failure is rethrown')
})

test('health reports the pool state and never the credentials', async t => {
  const server = await mock(t)
  const ok = await instance({ apiKey: keys.apiKey, apiUrl: server.apiUrl, subaccounts: SUBACCOUNTS }).telemetry.get('health')({})
  t.is(ok.status, 'OK')

  const bad = await instance({ apiKey: 'wrong-key', apiUrl: server.apiUrl, subaccounts: SUBACCOUNTS }, 'luxor-bad').telemetry.get('health')({})
  t.is(bad.status, 'OFFLINE')
  t.is(bad.error, 'ERR_LUXOR_AUTH')

  for (const value of [ok, bad]) {
    const text = JSON.stringify(value)
    t.absent(text.includes(keys.apiKey) || text.includes('wrong-key'), 'no API key in health')
  }
})

test('bad config and a bad key fail the channels, not the device', async t => {
  const server = await mock(t)
  const noScope = await metrics(instance({ apiKey: keys.apiKey, apiUrl: server.apiUrl }))
  t.ok(/ERR_LUXOR_SCOPE_REQUIRED/.test(noScope.hashrate.error))

  const noKey = await metrics(instance({ apiUrl: server.apiUrl, subaccounts: SUBACCOUNTS }, 'luxor-nokey'))
  t.ok(/ERR_LUXOR_API_KEY_REQUIRED/.test(noKey.balance.error))

  const badKey = await metrics(instance({ apiKey: 'wrong-key', apiUrl: server.apiUrl, subaccounts: SUBACCOUNTS }, 'luxor-badkey'))
  t.ok(/ERR_LUXOR_AUTH/.test(badKey.workers_online.error))
})

test('an unreachable API surfaces as a telemetry error', async t => {
  const inst = instance({ apiKey: keys.apiKey, apiUrl: 'http://127.0.0.1:9', subaccounts: SUBACCOUNTS })
  await t.exception(inst.telemetry.get('hashrate')({}), /ERR_LUXOR_API/)
})
