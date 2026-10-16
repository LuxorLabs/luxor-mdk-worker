# luxor-mdk-worker

[Tether MDK](https://github.com/tetherto/mdk) worker for the Luxor Bitcoin
mining pool. It reads hashrate, active miners, balance, 24-hour mining
revenue, the worker list and the transaction ledger for a set of
subaccounts or a site through the Luxor Pool API v2.

Built and tested against MDK v0.10.0.

## Install

MDK is not on the npm registry yet, so both MDK and this worker install from
git. Pin each one to a commit SHA, not a branch. In the project that runs
your MDK host:

```bash
npm install github:tetherto/mdk#<mdk-sha> github:LuxorLabs/luxor-mdk-worker#<worker-sha>
npm --prefix node_modules/@tetherto/mdk install --ignore-scripts
```

The second command installs MDK's own dependencies, which npm skips for a git
dependency. The worker declares `@tetherto/mdk` as a peer dependency and uses
the copy your project installs. The worker has no install scripts, so
`--ignore-scripts` is safe for both packages.

## Develop and test

Use Node.js 24 or later and npm 11:

```bash
npm ci --ignore-scripts
npm run setup:mdk
npm test
node examples/mock.js
```

`npm ci` installs the MDK version this repository pins in `devDependencies`.
The tests run against a local HTTP mock and a local DHT test network, so they
need no Luxor credentials. `examples/mock.js` starts the mock, polls it once
and prints the four metrics as JSON.

To check a real key against the production API, set `LUXOR_API_KEY` and
either `LUXOR_SUBACCOUNTS` (comma-separated) or `LUXOR_SITE_ID`, then run
`node examples/verify-live.js`. Set `LUXOR_API_URL` to
`https://app.sandbox.luxorlabs.dev/api` to use the sandbox. The script only
reads, prints `OK` per metric and exits nonzero if any metric is unavailable.

## Usage

`startLuxorWorker` boots one pool device on `WorkerRuntime`. The device ID is
the `workerId`, and the configured subaccounts or site report through that
one device.

```js
const { startLuxorWorker } = require('luxor-mdk-worker')

async function main () {
  const worker = await startLuxorWorker({
    workerId: 'luxor-site-1',
    rack: 'site-1',
    storeDir: './store/luxor-site-1',
    conf: {
      luxor: {
        apiKey: process.env.LUXOR_API_KEY,
        subaccounts: ['my-subaccount']
      }
    }
  })

  // Register this public key with your Kernel.
  console.log(worker.runtime.getPublicKey().toString('hex'))
  process.once('SIGINT', () => worker.stop())
  process.once('SIGTERM', () => worker.stop())
}

main().catch(console.error)
```

The package also exports `plugin` and the `LUXOR_POOL` manager class. All
imports from MDK go through `src/mdk.js`, the only file that knows the
monorepo layout.

| Boot option | Required | Meaning |
| --- | --- | --- |
| `workerId` | Yes | Unique runtime and device ID |
| `rack` | Yes | Rack identifier, used as the store prefix |
| `storeDir` | Yes | Directory for the persistent store |
| `conf.luxor` | Yes | API settings, see below |
| `root` | No | Directory holding an optional `config/luxor.json` overlay |
| `kernelTopic` | No | Kernel discovery topic as hex |
| `bootstrap` | No | DHT bootstrap list for a private or test network |

| API setting | Default | Meaning |
| --- | --- | --- |
| `apiUrl` | `https://app.luxor.tech/api` | Base URL, without the `/v2` path |
| `apiKey` | Required | Luxor API key, sent in the `authorization` header |
| `currency` | `BTC` | Only Bitcoin is supported. Any other value fails `init()` |
| `subaccounts` | `[]` | Subaccount names to report on |
| `siteId` | `null` | Site UUID to report on, instead of `subaccounts` |

The Luxor API needs a scope on every pool request, so set exactly one of
`subaccounts` and `siteId`. `init()` rejects both, neither, duplicate or empty
names, and a site ID that is not a UUID. Keep the key in an ignored local
config file or in an environment variable. A read-only key is enough.

## Telemetry

| Metric | Unit | Source |
| --- | --- | --- |
| `hashrate` | H/s | `hashrate_5m` from `/v2/pool/summary/BTC` |
| `workers_online` | Count | `active_miners` from the summary |
| `balance` | BTC | BTC entry of `balance` from the summary |
| `estimated_earnings` | BTC | BTC `MINING` entries of `revenue_24h` from the summary |

Luxor reports the last 24 hours of revenue, so that figure stands in for
today's estimate. Referral and LuxOS rebate revenue are not mining revenue
and are left out. A currency array without a BTC entry reads as zero. A
missing or malformed array fails the poll.

Statistics refresh every minute and the worker list every five minutes. If a
poll is still running when the next tick fires, the tick joins the running
poll instead of starting another. Metric handlers answer `E_POOL_API` until
the first successful poll, after a failed poll, and whenever the snapshot is
older than three minutes. A failed poll keeps the previous snapshot in memory
so you can inspect it.

The `stats` extension carries one entry for the whole scope, named after the
subaccounts or `site:<id>`. It adds `efficiency`, `uptime_24h`, `hashprice`
and `revenue_all_time` to the shared pool fields. `unsettled` is always
`null` because the API does not expose pending payouts. `hashrate_1h` and the
stale hashrates are not in the published API schema, so they are `null`
unless the API sends them. `yearlyBalances` holds the mining revenue credited
in the current month and the eleven before it, cached for an hour.

Per-worker records carry the subaccount as `username`, the current hashrate,
share efficiency, stale and rejected shares, and firmware. The workers
endpoint gives no 1h or 24h averages, so those fields are absent.

Amounts become JavaScript numbers at the MDK boundary. Treat them as
telemetry, not as figures for accounting or transaction signing.

## Transactions

The daily job runs at midnight UTC and stores every ledger row of the day
that just ended, credits and debits both. Each record has the subaccount,
the Luxor transaction ID, the type, the category, the amount in BTC and the
time in Unix seconds.

`getWrkExtData({ query: { key: 'transactions', start, end } })` reads these
records with millisecond bounds. With `aggrHourly`, the worker spreads the
credited amounts over the hours of the range. Debits are payouts and fees,
so they do not count against revenue.

## Requests

All calls, including history pages, go through one queue that spaces them at
least one second apart. Paginated endpoints are read with a page size of 100
until `next_page_url` is `null`. Requests time out after 30 seconds and abort
when the worker stops. Requests do not follow redirects. Error messages carry
no response bodies and no API key. An HTTP 401 surfaces as `ERR_LUXOR_AUTH`.

## Health and troubleshooting

The contract declares `OK`, `DEGRADED` and `OFFLINE`, plus
`alert.pool_unreachable` and `alert.hashrate_low`, same as the other pool
workers. The runtime health ping only says whether the process is reachable.
It does not call the Luxor API, so watch the metric errors and the poll log
for API trouble.

`ERR_LUXOR_AUTH` means the key is wrong or revoked. HTTP 400 usually means a
subaccount name or site ID the workspace does not have. `E_POOL_API` means
the last poll failed or the snapshot is stale, so look at the poll log first.
Before escalating low hashrate, compare it with what the miners themselves
report.

## Mock

```bash
npm run mock
```

The mock listens on `127.0.0.1:5066` and serves the `/v2/pool` summary,
workers and transactions routes. It checks the API key, requires a
subaccount or site scope, rejects subaccounts outside its workspace,
paginates with `next_page_url` and rejects an `end_date` in the future. The
key in `mock/keys.js` is a public fixture and does not work against Luxor. In
tests, `createServer({ port: 0 })` picks a free port and returns the server
handle and its state.
