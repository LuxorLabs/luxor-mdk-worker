'use strict'

const test = require('brittle')
const { getWorkersStats } = require('../../src/utils/workers')
const { previousDay, getMonthlyDateRanges } = require('../../src/utils/dates')
const { toNumber } = require('../../src/utils/numbers')
const defaultState = require('../../mock/state')

test('normalizes Luxor worker rows', t => {
  const [active, inactive] = getWorkersStats(defaultState(new Date('2026-09-22T00:00:00Z')).workers)
  t.is(active.username, 'mock-sub-1')
  t.is(active.online, 1)
  t.is(active.hashrate, 150e12)
  t.is(active.last_updated, Date.parse('2026-09-22T00:00:00Z') / 1000)
  t.is(inactive.online, 0)
  t.exception(() => getWorkersStats([{ id: 'x' }]), /ERR_LUXOR_DATA worker/)
  t.exception(() => getWorkersStats([{ ...active, id: 'x', subaccount_name: 's', hashrate: 'fast' }]), /worker.hashrate/)
})

test('date helpers use UTC days and months', t => {
  t.alike(previousDay(new Date('2026-09-22T00:00:00Z')), {
    start: Date.parse('2026-09-21T00:00:00Z'),
    end: Date.parse('2026-09-22T00:00:00Z'),
    date: '2026-09-21'
  })
  const ranges = getMonthlyDateRanges(new Date('2026-01-15T00:00:00Z'))
  t.is(ranges.length, 12)
  t.is(ranges[0].month, '1-2026')
  t.is(ranges[11].month, '2-2025')
})

test('toNumber never turns missing data into zero', t => {
  t.is(toNumber('150000000000000', 'x'), 150e12)
  t.exception(() => toNumber(undefined, 'x'), /ERR_LUXOR_DATA x/)
  t.exception(() => toNumber('', 'x'), /ERR_LUXOR_DATA x/)
})
