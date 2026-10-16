'use strict'

const SITE_ID = '4c0d1e8a-6f0b-4e7e-9a55-0d4f1b2c3d4e'

/**
 * Canned workspace for the mock: two subaccounts on one site.
 * Hashrates are H/s. Amounts are BTC.
 */
module.exports = (now = new Date()) => {
  const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10)
  const site = { id: SITE_ID, name: 'Mock Site' }
  return {
    siteId: SITE_ID,
    subaccounts: [
      { id: 1, name: 'mock-sub-1', site },
      { id: 2, name: 'mock-sub-2', site }
    ],
    summary: {
      hashrate_5m: '150000000000000',
      hashrate_1h: '145000000000000',
      hashrate_24h: '140000000000000',
      efficiency_5m: 0.995,
      uptime_24h: 0.99,
      active_miners: 1,
      revenue_24h: [
        { currency_type: 'BTC', revenue_type: 'MINING', revenue: 0.00012 },
        { currency_type: 'BTC', revenue_type: 'REFERRAL', revenue: 0.00001 }
      ],
      revenue_all_time: [{ currency_type: 'BTC', revenue_type: 'MINING', revenue: 0.5 }],
      balance: [{ currency_type: 'BTC', revenue: 0.00125 }],
      hashprice: [{ currency_type: 'BTC', value: 0.0000005 }]
    },
    workers: [
      { currency_type: 'BTC', id: 'w-1', subaccount_name: 'mock-sub-1', name: 'rig-1', firmware: 'LuxOS 2026.9.1', hashrate: 150e12, efficiency: 0.995, stale_shares: 0, rejected_shares: 2, last_share_time: now.toISOString(), status: 'ACTIVE' },
      { currency_type: 'BTC', id: 'w-2', subaccount_name: 'mock-sub-2', name: 'rig-2', firmware: 'Stock', hashrate: 0, efficiency: 0, stale_shares: 0, rejected_shares: 0, last_share_time: '2026-01-01T00:00:00Z', status: 'INACTIVE' }
    ],
    transactions: [
      { currency_type: 'BTC', date_time: `${yesterday}T00:30:00Z`, address_name: 'wallet-1', subaccount_name: 'mock-sub-1', transaction_category: 'Miner Revenue', currency_amount: 0.00012, usd_equivalent: 12, transaction_id: 'mock-credit-1', transaction_type: 'credit' },
      { currency_type: 'BTC', date_time: `${yesterday}T12:00:00Z`, address_name: 'wallet-1', subaccount_name: 'mock-sub-1', transaction_category: 'Payout', currency_amount: 0.0001, usd_equivalent: 10, transaction_id: 'mock-debit-1', transaction_type: 'debit' }
    ]
  }
}
