'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { LUXOR_POOL } = require('..')
const { createServer } = require('../mock/server')
const keys = require('../mock/keys')

const METRICS = {
  hashrate: 'hashrate',
  workers_online: 'active_workers_count',
  balance: 'balance',
  estimated_earnings: 'estimated_today_income'
}

async function main () {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdk-luxor-example-'))
  const mock = await createServer({ port: 0 })
  const pool = new LUXOR_POOL(
    { luxor: { ...keys, apiUrl: mock.apiUrl, subaccounts: ['mock-sub-1', 'mock-sub-2'] } },
    { rack: 'example', root: storeDir, storeDir }
  )

  try {
    await pool.init()

    const now = new Date()
    await pool.fetchWorkers(now)
    await pool.fetchStats(now)
    await pool.fetchTransactions(now)

    const report = Object.fromEntries(
      Object.entries(METRICS).map(([name, field]) => [name, pool.getMetric(field)])
    )
    console.log(JSON.stringify(report, null, 2))
  } finally {
    await new Promise(resolve => pool.stop(resolve))
    await mock.app.close()
    fs.rmSync(storeDir, { recursive: true, force: true })
  }
}

main().catch(err => {
  console.error(err.message)
  process.exitCode = 1
})
