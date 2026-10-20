'use strict'

const test = require('brittle')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const createTestnet = require('hyperdht/testnet')
const HyperswarmRPC = require('@hyperswarm/rpc')
const { createServer } = require('../../mock/server')
const keys = require('../../mock/keys')
const { startLuxorWorker, LUXOR_POOL } = require('../..')
const { ACTIONS, MESSAGE_TYPES, build, serialize, deserialize } = require('../../src/mdk').protocol
const { previousDay } = require('../../src/utils/dates')

const SUBACCOUNTS = ['mock-sub-1', 'mock-sub-2']

function tempDir (t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mdk-luxor-${name}-`))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('worker serves telemetry over HRPC against the mock', { timeout: 60000 }, async t => {
  const testnet = await createTestnet(3, t.teardown)
  const mock = await createServer({ port: 0 })
  t.teardown(() => mock.app.close())
  const storeDir = tempDir(t, 'test')
  const worker = await startLuxorWorker({
    workerId: 'luxor-test',
    rack: 'test',
    storeDir,
    root: storeDir,
    bootstrap: testnet.bootstrap,
    conf: { luxor: { ...keys, apiUrl: mock.apiUrl, subaccounts: SUBACCOUNTS } }
  })
  t.teardown(() => worker.stop())
  worker.pool._logErr = () => {}

  const rpc = new HyperswarmRPC({ bootstrap: testnet.bootstrap })
  t.teardown(() => rpc.destroy())
  const send = async query => {
    const envelope = build({
      type: MESSAGE_TYPES.REQUEST,
      sender: 'kernel:kernel:test',
      action: ACTIONS.TELEMETRY_PULL,
      deviceId: 'luxor-test',
      payload: { query }
    })
    return deserialize(await rpc.request(worker.runtime.getPublicKey(), 'mdk', serialize(envelope)))
  }

  const initial = await send({ type: 'metrics' })
  t.ok(initial.payload.metrics.hashrate.error.includes('E_POOL_API'), 'no fabricated startup zeros')
  t.alike(initial.payload.metrics.health, { status: 'OFFLINE', error: 'E_POOL_API' })

  const now = new Date()
  await worker.pool.fetchWorkers(now)
  await worker.pool.fetchStats(now)
  await worker.pool.fetchTransactions(now)

  const { metrics } = (await send({ type: 'metrics' })).payload
  t.is(metrics.hashrate, 150e12)
  t.is(metrics.workers_online, 1)
  t.is(metrics.balance, 0.00125)
  t.is(metrics.estimated_earnings, 0.00012)
  t.alike(metrics.health, { status: 'OK' })
  t.absent(JSON.stringify(metrics).includes(keys.apiKey), 'the API key never leaves the worker')

  const workers = await worker.pool.getWorkers({})
  t.is(workers.workers.length, 2)
  t.is(workers.workers[0].poolType, 'luxor')

  const { start, end } = previousDay(now)
  const transactions = await worker.pool.getWrkExtData({ query: { key: 'transactions', start, end } })
  t.alike(transactions[0].transactions.map(row => row.type), ['credit', 'debit'])
  t.is(worker.pool.data.statsData.stats[0].yearlyBalances.length, 12)
})

test('a site ID scope works end to end', { timeout: 30000 }, async t => {
  const mock = await createServer({ port: 0 })
  t.teardown(() => mock.app.close())
  const storeDir = tempDir(t, 'site')
  const pool = new LUXOR_POOL({ luxor: { ...keys, apiUrl: mock.apiUrl, siteId: mock.state.siteId } }, { rack: 'test', root: storeDir, storeDir })
  await pool.init()
  t.teardown(() => new Promise(resolve => pool.stop(resolve)))
  await pool.fetchWorkers(new Date())
  t.is(pool.data.workersData.workers.length, 2)
})

test('stopping the pool aborts an in-flight HTTP request and removes signal listeners', async t => {
  let received
  const requestReceived = new Promise(resolve => {
    received = resolve
  })
  const server = http.createServer(() => received())
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise(resolve => {
    server.closeAllConnections(); server.close(resolve)
  }))
  const storeDir = tempDir(t, 'stop')
  const before = process.listenerCount('SIGTERM')
  const pool = new LUXOR_POOL({ luxor: { ...keys, apiUrl: `http://127.0.0.1:${server.address().port}`, subaccounts: SUBACCOUNTS } }, { rack: 'test', root: storeDir, storeDir })
  await pool.init()
  t.teardown(() => new Promise(resolve => pool.stop(resolve)))
  t.is(process.listenerCount('SIGTERM'), before + 1)
  const pending = pool.fetchStats(new Date())
  const rejected = t.exception(pending, /abort/i)
  await requestReceived
  await new Promise(resolve => pool.stop(resolve))
  await rejected
  t.is(process.listenerCount('SIGTERM'), before)
  await t.exception(pool.fetchStats(new Date()), /abort/i)
})

test('invalid configuration fails before opening a persistent store', async t => {
  const storeDir = tempDir(t, 'invalid')
  const configs = [
    {},
    { ...keys },
    { ...keys, subaccounts: ['same', 'same'] },
    { ...keys, subaccounts: ['a'], currency: 'ZEC' },
    { ...keys, siteId: 'not-a-uuid' }
  ]
  for (const config of configs) {
    const pool = new LUXOR_POOL({ luxor: config }, { rack: 'test', root: storeDir, storeDir })
    await t.exception(pool.init(), /ERR_LUXOR_/)
    t.is(pool.store_s1, undefined)
  }
})
