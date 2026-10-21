'use strict'

// Read-only check against the real Luxor API. It runs every telemetry
// handler from mdk-contract.json, so it checks exactly what MDK will
// publish. The Luxor API is read-only for this worker.
// Usage: LUXOR_API_KEY=... npm run test:live -- --subaccounts a,b
//        LUXOR_API_KEY=... npm run test:live -- --site <site-id>
//        LUXOR_API_URL overrides the API base URL, e.g. for the sandbox

const path = require('node:path')
const { parseArgs } = require('node:util')
const { loadContract, createInstance } = require('@tetherto/mdk/backend/core/mdk-worker')

const WORKER_DIR = path.resolve(__dirname, '..')

async function main () {
  const { values } = parseArgs({ options: { subaccounts: { type: 'string' }, site: { type: 'string' } } })
  const apiKey = process.env.LUXOR_API_KEY
  if (!apiKey || (!values.subaccounts === !values.site)) {
    throw new Error('Usage: LUXOR_API_KEY=... npm run test:live -- --subaccounts a,b | --site <site-id>')
  }

  const apiUrl = process.env.LUXOR_API_URL
  const opts = values.site
    ? { apiKey, apiUrl, siteId: values.site }
    : { apiKey, apiUrl, subaccounts: values.subaccounts.split(',').map(name => name.trim()) }
  const { entries } = loadContract(WORKER_DIR)
  const instance = createInstance({ dir: WORKER_DIR, entries, device: { id: 'live', opts } })

  let failed = 0
  for (const name of entries.telemetry.keys()) {
    try {
      const value = await instance.telemetry.get(name)({})
      // health reports an outage as a value, not a throw.
      if (name === 'health' && value?.status !== 'OK') throw new Error(JSON.stringify(value))
      console.log(`${name}: ${JSON.stringify(value)}`)
    } catch (err) {
      failed++
      console.log(`${name}: FAILED ${err.message}`)
    }
  }
  if (failed) throw new Error(`${failed} channel(s) failed`)
  console.log('Luxor live read-only check passed')
}

main().catch(err => {
  console.error(err.message)
  process.exitCode = 1
})
