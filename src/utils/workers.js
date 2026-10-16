'use strict'

const { DataError } = require('../errors')
const { toNumber } = require('./numbers')
const { toTimestamp } = require('./dates')
const { WORKER_STATUS_ACTIVE } = require('../constants')

/**
 * Raw worker row from GET /v2/pool/workers/{currency}.
 * @typedef {Object} LuxorWorker
 * @property {string} id
 * @property {string} subaccount_name
 * @property {string} name
 * @property {string} firmware
 * @property {number} hashrate        H/s
 * @property {number} efficiency      share acceptance, 0 to 1
 * @property {number} stale_shares
 * @property {number} rejected_shares
 * @property {string|null} last_share_time ISO 8601
 * @property {'ACTIVE'|'INACTIVE'|'UNSPECIFIED'} [status]
 */

/**
 * Normalized worker shared with the other pool workers. Luxor reports only
 * the current hashrate per worker, so there are no 1h or 24h averages.
 * @typedef {Object} WorkerStats
 * @property {string} username     subaccount name
 * @property {string} id
 * @property {string} name
 * @property {0|1} online
 * @property {number|null} last_updated unix seconds of the last share
 * @property {number} hashrate     H/s
 * @property {number} efficiency
 * @property {number} stale_shares
 * @property {number} rejected_shares
 * @property {string} firmware
 */

function isNonEmptyString (value) {
  return typeof value === 'string' && value.length > 0
}

/**
 * @param {LuxorWorker} worker
 * @returns {WorkerStats}
 */
function toWorkerStats (worker) {
  const isValid = Boolean(worker) &&
    isNonEmptyString(worker.id) &&
    isNonEmptyString(worker.name) &&
    isNonEmptyString(worker.subaccount_name)
  if (!isValid) {
    throw new DataError('worker')
  }

  const lastShare = worker.last_share_time ?? null
  return {
    username: worker.subaccount_name,
    id: worker.id,
    name: worker.name,
    online: worker.status === WORKER_STATUS_ACTIVE ? 1 : 0,
    last_updated: lastShare === null ? null : Math.floor(toTimestamp(lastShare, 'worker.last_share_time') / 1000),
    hashrate: toNumber(worker.hashrate, 'worker.hashrate'),
    efficiency: toNumber(worker.efficiency, 'worker.efficiency'),
    stale_shares: toNumber(worker.stale_shares, 'worker.stale_shares'),
    rejected_shares: toNumber(worker.rejected_shares, 'worker.rejected_shares'),
    firmware: typeof worker.firmware === 'string' ? worker.firmware : ''
  }
}

/**
 * @param {LuxorWorker[]} workers
 * @returns {WorkerStats[]}
 */
function getWorkersStats (workers) {
  return workers.map(toWorkerStats)
}

module.exports = { getWorkersStats }
