'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { LUXOR_POOL } = require('..')

const METRIC_FIELDS = ['hashrate', 'active_workers_count', 'balance', 'estimated_today_income']

function readConfig (env) {
  const { LUXOR_API_KEY: apiKey, LUXOR_SUBACCOUNTS: subaccounts, LUXOR_SITE_ID: siteId, LUXOR_API_URL: apiUrl } = env
  if (!apiKey || (!subaccounts && !siteId)) {
    throw new Error('Set LUXOR_API_KEY and either LUXOR_SUBACCOUNTS (comma-separated) or LUXOR_SITE_ID')
  }
  return {
    apiKey,
    ...(apiUrl ? { apiUrl } : {}),
    ...(siteId ? { siteId } : { subaccounts: subaccounts.split(',').map(name => name.trim()) })
  }
}

async function main () {
  const luxor = readConfig(process.env)
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdk-luxor-live-'))
  const pool = new LUXOR_POOL({ luxor }, { rack: 'verify', root: storeDir, storeDir })

  try {
    await pool.init()
    await pool.fetchWorkers(new Date())
    await pool.fetchStats(new Date())

    for (const field of METRIC_FIELDS) {
      if (!Number.isFinite(pool.getMetric(field))) {
        throw new Error(`Invalid ${field}`)
      }
      console.log(`${field}: OK`)
    }
    console.log(`workers: ${pool.data.workersData.workers.length}`)
    console.log('Luxor live verification passed')
  } finally {
    await new Promise(resolve => pool.stop(resolve))
    fs.rmSync(storeDir, { recursive: true, force: true })
  }
}

main().catch(err => {
  console.error(err.message)
  process.exitCode = 1
})
