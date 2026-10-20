'use strict'

const path = require('node:path')
const { errorCode } = require('./errors')

// The contract's handler files are written for directory loading
// (WorkerRuntimeV2). On WorkerRuntime the device is a LuxorPool, so each
// channel reads the pool's last poll instead.
const METRICS = {
  hashrate: 'hashrate',
  workers_online: 'active_workers_count',
  balance: 'balance',
  estimated_earnings: 'estimated_today_income'
}

function loadHandler (file, { section, name }) {
  if (name === 'health') {
    // Replaces the builtin health channel, which echoes the device config,
    // and the config holds the pool and its API key.
    return async (ctx) => {
      try {
        ctx.device.getMetric('hashrate')
        return { status: 'OK' }
      } catch (err) {
        // The poll's own error (ERR_LUXOR_AUTH, ...) matches what the
        // directory-loaded handler reports; E_POOL_API is left for "no fresh
        // poll yet", which only this runtime has.
        return { status: 'OFFLINE', error: errorCode(ctx.device._statsError || err) }
      }
    }
  }
  const metric = METRICS[name]
  if (section !== 'telemetry' || !metric) throw new Error(`no WorkerRuntime handler for ${section}.${name}`)
  return async (ctx) => ctx.device.getMetric(metric)
}

// Contract handler paths are relative to the package root.
module.exports = {
  contract: require('../mdk-contract.json'),
  dir: path.join(__dirname, '..'),
  loadHandler,
  connect: async (config) => {
    if (!config.pool) {
      throw new Error('ERR_POOL_REQUIRED')
    }
    return config.pool
  }
}
