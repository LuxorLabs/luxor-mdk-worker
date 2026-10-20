# luxor-mdk-worker

[Tether MDK](https://github.com/tetherto/mdk) worker for the Luxor Bitcoin
mining pool. It reads hashrate, active miners, balance and 24-hour mining
revenue for a set of subaccounts or a site through the read-only Luxor Pool
API v2.

Built and tested against MDK v0.10.0.

## Install

MDK is not on the npm registry yet, so both MDK and this worker install from
git. Pin each one to a commit SHA, not a branch:

```bash
npm install github:tetherto/mdk#<mdk-sha> github:LuxorLabs/luxor-mdk-worker#<worker-sha>
npm --prefix node_modules/@tetherto/mdk install --ignore-scripts
```

The second command installs MDK's own dependencies, which npm skips for a git
dependency. The worker has no runtime dependencies and no install scripts.

## Usage

The worker runs on either MDK worker runtime. Pick one:

- **Directory-loaded (`WorkerRuntimeV2`)**: telemetry channels only, one
  device per Luxor scope. Lightest option.
- **Standalone (`WorkerRuntime`, `startLuxorWorker`)**: the same channels,
  plus the pool extensions Tether's pool workers expose (`stats`, per-worker
  records, transactions, monthly revenue history). Use this if your site reads
  pool `ext_data`, as MDK's example sites do.

### Directory-loaded

The package is `mdk-contract.json` plus the handler files it names. Point
`WorkerRuntimeV2` at the package directory and add one device per scope:

```js
const path = require('node:path')
const { WorkerRuntimeV2 } = require('@tetherto/mdk/backend/core/mdk-worker')

async function main () {
  const runtime = new WorkerRuntimeV2(
    path.dirname(require.resolve('luxor-mdk-worker/mdk-contract.json')),
    {
      workerId: 'luxor-pool',
      storeDir: './store/luxor-pool',
      devices: [
        { deviceId: 'luxor-site-1', config: { apiKey: process.env.LUXOR_API_KEY, subaccounts: ['my-subaccount'] } }
      ]
    }
  )

  await runtime.start()
  // Register this public key with your Kernel.
  console.log(runtime.getPublicKey().toString('hex'))
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
```

| Device config | Default | Meaning |
| --- | --- | --- |
| `apiKey` | Required | Luxor API key, sent in the `authorization` header. A read-only key is enough |
| `subaccounts` | | Subaccount names to report on |
| `siteId` | | Site UUID to report on, instead of `subaccounts` |
| `apiUrl` | `https://app.luxor.tech/api` | Base URL without the `/v2` path. The sandbox is `https://app.sandbox.luxorlabs.dev/api` |

### Standalone

`startLuxorWorker` boots one pool device on `WorkerRuntime`. The device ID is
the `workerId`, and the configured subaccounts or site report through it.

```js
const { startLuxorWorker } = require('luxor-mdk-worker')

async function main () {
  const worker = await startLuxorWorker({
    workerId: 'luxor-site-1',
    rack: 'site-1',
    storeDir: './store/luxor-site-1',
    conf: { luxor: { apiKey: process.env.LUXOR_API_KEY, subaccounts: ['my-subaccount'] } }
  })

  // Register this public key with your Kernel.
  console.log(worker.runtime.getPublicKey().toString('hex'))
  process.once('SIGTERM', () => worker.stop())
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
```

| Boot option | Required | Meaning |
| --- | --- | --- |
| `workerId` | Yes | Unique runtime and device ID |
| `rack` | Yes | Rack identifier, used as the store prefix |
| `storeDir` | Yes | Directory for the persistent store |
| `conf.luxor` | Yes | `apiKey`, `subaccounts` or `siteId`, `apiUrl`, as in the table above |
| `root` | No | Directory holding an optional `config/luxor.json` overlay |
| `kernelTopic` | No | Kernel discovery topic as hex |
| `bootstrap` | No | DHT bootstrap list for a private or test network |

The package also exports `plugin` and the `LUXOR_POOL` manager class. All
imports from MDK go through `src/mdk.js`, the only file that knows the
monorepo layout.

Either way, set exactly one of `subaccounts` and `siteId`. Keep the key out of
source control, for example in an environment variable. The worker never
returns the key in telemetry, including the `health` channel.

## Telemetry

| Channel | Unit | Source |
| --- | --- | --- |
| `hashrate` | H/s | `hashrate_5m` from `/v2/pool/summary/BTC` |
| `workers_online` | Count | `active_miners` from the summary |
| `balance` | BTC | BTC entry of `balance`. It can be negative |
| `estimated_earnings` | BTC | BTC `MINING` entries of `revenue_24h` |
| `health` | | `{ status: 'OK' }`, or `{ status: 'OFFLINE', error }` with an error code |

Luxor reports the last 24 hours of revenue, so that figure stands in for
today's estimate. Referral and LuxOS rebate revenue are not mining revenue
and are left out. A currency array without a BTC entry reads as zero; a
missing or malformed field fails the channel.

Directory-loaded, one summary request serves every channel and is reused for
30 seconds, so a metrics pull costs at most one API call per device. A failed
request is reported on every channel for 10 seconds instead of being retried
per channel. Requests are spaced at
least one second apart, time out after 30 seconds and do not follow
redirects. Error messages carry no response bodies and no API key. Amounts
are JavaScript numbers: treat them as telemetry, not as accounting figures.

### Standalone extras

On `WorkerRuntime` the channels read the pool manager's last poll instead of
calling the API. Statistics refresh every minute and the worker list every
five minutes; a tick that fires while a poll is running joins it. Channels
answer `E_POOL_API` until the first successful poll, after a failed poll and
whenever the snapshot is older than three minutes. `health` then reports the
failed poll's own code, such as `ERR_LUXOR_AUTH`, the same as the
directory-loaded worker, and `E_POOL_API` only before the first successful
poll or when the snapshot is stale.

The `stats` extension carries one entry for the whole scope, named after the
subaccounts or `site:<id>`, and adds `efficiency`, `uptime_24h`, `hashprice`,
`revenue_all_time` and `yearlyBalances` (mining revenue credited in each of
the last twelve months, cached for an hour). `unsettled` is always `null`
because the API does not expose pending payouts. Per-worker records carry the
subaccount as `username`, hashrate, share efficiency, stale and rejected
shares, and firmware.

A daily job at midnight UTC stores every ledger row of the day that just
ended, credits and debits both.
`getWrkExtData({ query: { key: 'transactions', start, end } })` reads them
with millisecond bounds; with `aggrHourly`, credited amounts are spread over
the hours of the range. Debits are payouts and fees, not negative revenue.

## Troubleshooting

| Error | Meaning |
| --- | --- |
| `ERR_LUXOR_AUTH` | The key is wrong or revoked |
| `ERR_LUXOR_API … 403` | A subaccount or site the key's workspace does not have |
| `ERR_LUXOR_SCOPE_REQUIRED` | Neither or both of `subaccounts` and `siteId` are set |
| `ERR_LUXOR_API_KEY_REQUIRED` | `apiKey` is missing |

Before escalating low hashrate, compare it with what the miners themselves
report.

## Develop and test

Use Node.js 24 or later and npm 11:

```bash
npm ci --ignore-scripts
npm run setup:mdk
npm test
```

The tests run against a local mock of the Luxor API, so they need no
credentials. The integration suite registers the worker with a real MDK
Kernel in both runtimes and checks that it reaches `READY`, serves every
channel and never exposes the key. CI also runs Tether's worker smoke test with
`smoke.config.js`.

To check a real key against the production API:

```bash
LUXOR_API_KEY=... npm run test:live -- --subaccounts a,b
LUXOR_API_KEY=... npm run test:live -- --site <site-id>
```

It prints every channel and exits nonzero if any channel fails. Set
`LUXOR_API_URL` to check against the sandbox instead.

## Mock

```bash
npm run mock
```

The mock listens on `127.0.0.1:5066` and serves the `/v2/pool` summary,
workers and transactions routes. It checks the API key, requires a
subaccount or site scope, rejects subaccounts outside its workspace and
paginates with `next_page_url`. The key in `mock/keys.js` is a public
fixture and does not work against Luxor. In tests,
`createServer({ port: 0 })` picks a free port and returns the server handle,
its state and the requests it received.
