'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('brittle')
const { WorkerRuntimeV2 } = require('@tetherto/mdk/backend/core/mdk-worker')
const mdk = require('@tetherto/mdk/backend/core/mdk')
const { createMdkClient } = require('@tetherto/mdk/backend/core/client')
const { createServer } = require('../../mock/server')
const keys = require('../../mock/keys')
const contract = require('../../mdk-contract.json')
const { startLuxorWorker } = require('../..')

const PKG_DIR = path.join(__dirname, '..', '..')
const TYPE_OK = {
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  object: (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
}

test('a real Kernel takes the worker to READY and serves pool data right away', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luxor-kernel-'))
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }))

  const server = await createServer({ port: 0 })
  t.teardown(() => server.app.close())

  const runtime = new WorkerRuntimeV2(PKG_DIR, {
    workerId: 'luxor-kernel-test',
    devices: [{ deviceId: 'luxor-0', config: { apiKey: keys.apiKey, apiUrl: server.apiUrl, subaccounts: ['mock-sub-1', 'mock-sub-2'] } }],
    storeDir: path.join(root, 'worker')
  })
  t.teardown(() => runtime.stop())
  await runtime.start()

  const kernel = await mdk.getKernel({ root, discovery: { mode: 'local' } })
  t.teardown(() => mdk.shutdown(kernel))
  await kernel.registerWorker(runtime.getPublicKey())

  const workers = await mdk.waitForDiscovery(kernel, { minWorkers: 1, timeoutMs: 15000 })
  const worker = workers.find((w) => w.workerId === 'luxor-kernel-test')
  t.is(worker && worker.state, 'READY')
  t.alike(worker && worker.deviceIds, ['luxor-0'])

  const client = createMdkClient({ kernelKey: kernel.getPublicKey() })
  t.teardown(() => client.close())
  await client.connect()

  const { metrics } = await client.pullTelemetry('luxor-0', 'metrics')
  for (const entry of contract.capabilities.telemetry) {
    t.ok(TYPE_OK[entry.type](metrics[entry.name]), `${entry.name} is a ${entry.type} through the Kernel`)
  }
  t.is(metrics.hashrate, 150e12, 'first pull after READY already has data')
  t.is(metrics.health.status, 'OK')
  t.absent(JSON.stringify(metrics).includes(keys.apiKey), 'the API key never leaves the worker')
})

test('a real Kernel takes the standalone worker to READY and serves its last poll', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luxor-kernel-v1-'))
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }))

  const server = await createServer({ port: 0 })
  t.teardown(() => server.app.close())

  const worker = await startLuxorWorker({
    workerId: 'luxor-kernel-v1',
    rack: 'test',
    storeDir: path.join(root, 'worker'),
    root,
    conf: { luxor: { apiKey: keys.apiKey, apiUrl: server.apiUrl, subaccounts: ['mock-sub-1', 'mock-sub-2'] } }
  })
  t.teardown(() => worker.stop())
  worker.pool._logErr = () => {}

  const kernel = await mdk.getKernel({ root: path.join(root, 'kernel'), discovery: { mode: 'local' } })
  t.teardown(() => mdk.shutdown(kernel))
  await kernel.registerWorker(worker.runtime.getPublicKey())

  const workers = await mdk.waitForDiscovery(kernel, { minWorkers: 1, timeoutMs: 15000 })
  const found = workers.find((w) => w.workerId === 'luxor-kernel-v1')
  t.is(found && found.state, 'READY')
  t.alike(found && found.deviceIds, ['luxor-kernel-v1'])

  const now = new Date()
  await worker.pool.fetchWorkers(now)
  await worker.pool.fetchStats(now)

  const client = createMdkClient({ kernelKey: kernel.getPublicKey() })
  t.teardown(() => client.close())
  await client.connect()

  const { metrics } = await client.pullTelemetry('luxor-kernel-v1', 'metrics')
  for (const entry of contract.capabilities.telemetry) {
    t.ok(TYPE_OK[entry.type](metrics[entry.name]), `${entry.name} is a ${entry.type} through the Kernel`)
  }
  t.is(metrics.hashrate, 150e12)
  t.alike(metrics.health, { status: 'OK' })
  t.absent(JSON.stringify(metrics).includes(keys.apiKey), 'the API key never leaves the worker')
})
