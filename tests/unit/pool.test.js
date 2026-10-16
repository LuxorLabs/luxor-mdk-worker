'use strict'

const test = require('brittle')
const LuxorPool = require('../../src/pool')
const defaultState = require('../../mock/state')
const { previousDay } = require('../../src/utils/dates')

function pool (state = defaultState()) {
  const manager = new LuxorPool({}, { rack: 'test' })
  manager.scope = { subaccounts: ['mock-sub-1', 'mock-sub-2'] }
  manager._saveToDb = async () => {}
  manager.luxorApi = {
    getSummary: async () => ({ currency_type: 'BTC', subaccounts: state.subaccounts, ...state.summary }),
    getWorkers: async () => state.workers,
    getTransactions: async () => state.transactions
  }
  return { manager, state }
}

test('reports the four metrics from one summary request', async t => {
  const { manager } = pool()
  await manager.fetchWorkers(new Date())
  await manager.fetchStats(new Date())
  t.is(manager.getMetric('hashrate'), 150e12)
  t.is(manager.getMetric('active_workers_count'), 1)
  t.is(manager.getMetric('balance'), 0.00125)
  t.is(manager.getMetric('estimated_today_income'), 0.00012, 'referral revenue is not mining revenue')
  const [stats] = manager.data.statsData.stats
  t.is(stats.username, 'mock-sub-1,mock-sub-2')
  t.is(stats.worker_count, 2)
  t.is(stats.hashrate_1h, 145e12)
  t.is(stats.hashrate_stale_1h, null, 'fields outside the published schema stay null when absent')
  t.is(stats.unsettled, null)
  t.is(stats.yearlyBalances.length, 12)
})

test('a site scope reports under site:<id>', async t => {
  const { manager, state } = pool()
  manager.scope = { siteId: state.siteId }
  await manager.fetchStats(new Date())
  t.is(manager.data.statsData.stats[0].username, `site:${state.siteId}`)
})

test('a currency array without BTC reads as zero; a missing array fails the poll', async t => {
  const { manager, state } = pool()
  state.summary.balance = []
  await manager.fetchStats(new Date())
  t.is(manager.getMetric('balance'), 0)
  delete state.summary.balance
  await t.exception(manager.fetchStats(new Date()), /ERR_LUXOR_DATA summary.balance/)
  t.exception(() => manager.getMetric('hashrate'), /E_POOL_API/)
})

test('does not publish uninitialized zeros, failed polls or stale data', async t => {
  const { manager, state } = pool()
  t.exception(() => manager.getMetric('hashrate'), /E_POOL_API/)
  await manager.fetchStats(new Date())
  const previous = manager.data.statsData
  state.summary.hashrate_5m = 'n/a'
  await t.exception(manager.fetchStats(new Date()), /summary.hashrate_5m/)
  t.is(manager.data.statsData, previous, 'the last good snapshot stays for inspection')
  t.exception(() => manager.getMetric('hashrate'), /E_POOL_API/)
  state.summary.hashrate_5m = '1'
  await manager.fetchStats(new Date(Date.now() - 181000))
  t.exception(() => manager.getMetric('hashrate'), /stale/)
})

test('a summary in another currency is rejected', async t => {
  const { manager } = pool()
  manager.luxorApi.getSummary = async () => ({ ...defaultState().summary, currency_type: 'ZEC' })
  await t.exception(manager.fetchStats(new Date()), /summary.currency_type/)
})

test('monthly revenue sums credits by UTC month, caches, and refreshes on rollover', async t => {
  const { manager } = pool()
  const calls = []
  manager.luxorApi.getTransactions = async (scope, from, to, type) => {
    calls.push({ from, to, type })
    return [
      { currency_type: 'BTC', transaction_id: 'a', transaction_type: 'credit', currency_amount: 2, date_time: '2026-09-01T00:00:00Z', subaccount_name: 's' },
      { currency_type: 'BTC', transaction_id: 'b', transaction_type: 'credit', currency_amount: 1, date_time: '2026-08-31T23:59:59Z', subaccount_name: 's' }
    ]
  }
  const time = new Date('2026-09-22T05:00:00Z')
  const balances = await manager.getYearlyBalances(time)
  t.alike(balances.slice(0, 2), [{ month: '9-2026', balance: 2 }, { month: '8-2026', balance: 1 }])
  t.alike(calls[0], { from: '2025-10-01', to: '2026-09-22', type: 'credit' })
  await manager.getYearlyBalances(time)
  t.is(calls.length, 1)
  await manager.getYearlyBalances(new Date('2026-10-01T00:00:00Z'))
  t.is(calls.length, 2)
})

test('failed history requests are retried and never cached as zero', async t => {
  const { manager } = pool()
  manager.luxorApi.getTransactions = async () => {
    throw new Error('unavailable')
  }
  await t.exception(manager.getYearlyBalances(), /unavailable/)
  manager.luxorApi.getTransactions = async () => []
  t.is((await manager.getYearlyBalances()).length, 12)
})

test('overlapping polls share one fetch and release the slot after completion', async t => {
  const { manager, state } = pool()
  let calls = 0
  manager.luxorApi.getSummary = async () => {
    calls++
    return { currency_type: 'BTC', ...state.summary }
  }
  const a = manager.fetchStats(new Date())
  const b = manager.fetchStats(new Date())
  t.is(a, b)
  await Promise.all([a, b])
  t.is(calls, 1)
  await manager.fetchStats(new Date())
  t.is(calls, 2)
})

test('the daily job stores the previous UTC day only, credits and debits both', async t => {
  const { manager } = pool()
  const time = new Date('2026-09-22T00:00:00Z')
  const writes = []
  manager._saveToDb = async (db, ts, value) => writes.push({ ts, value })
  manager.luxorApi.getTransactions = async (scope, from, to, type) => {
    t.is(from, '2026-09-21')
    t.is(to, '2026-09-22')
    t.is(type, undefined)
    return [
      { currency_type: 'BTC', transaction_id: 'c', transaction_type: 'credit', transaction_category: 'Miner Revenue', currency_amount: 0.5, date_time: '2026-09-21T00:00:00Z', subaccount_name: 's' },
      { currency_type: 'BTC', transaction_id: 'd', transaction_type: 'debit', transaction_category: 'Payout', currency_amount: 0.2, date_time: '2026-09-21T23:59:59Z', subaccount_name: 's' },
      { currency_type: 'BTC', transaction_id: 'next', transaction_type: 'credit', currency_amount: 9, date_time: '2026-09-22T00:00:00Z', subaccount_name: 's' }
    ]
  }
  await manager.fetchTransactions(time)
  t.is(writes.length, 1)
  t.is(writes[0].ts, previousDay(time).start)
  t.alike(writes[0].value.transactions.map(row => row.id), ['c', 'd'])

  const day = previousDay(time)
  const hourly = manager._aggrTransactions([writes[0].value], { start: day.start, end: day.end })
  const total = hourly.hourlyRevenues.reduce((sum, row) => sum + row.revenue, 0)
  t.ok(Math.abs(total - 0.5) < 1e-9, 'hourly revenue counts credits only')
})

test('a malformed ledger row fails the day instead of being dropped', async t => {
  const { manager } = pool()
  let writes = 0
  manager._saveToDb = async () => writes++
  manager.luxorApi.getTransactions = async () => [{ transaction_type: 'refund' }]
  await t.exception(manager.fetchTransactions(new Date()), /ERR_LUXOR_DATA transaction/)
  t.is(writes, 0)
})

test('a failed worker poll keeps the previous list and count', async t => {
  const { manager } = pool()
  let writes = 0
  manager._saveToDb = async () => writes++
  await manager.fetchWorkers(new Date())
  const previous = manager.data.workersData
  manager.luxorApi.getWorkers = async () => {
    throw new Error('unavailable')
  }
  await t.exception(manager.fetchWorkers(new Date()), /unavailable/)
  t.is(manager.data.workersData, previous)
  t.is(writes, 1)
})
