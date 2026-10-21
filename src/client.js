'use strict'

const { opts } = require('@tetherto/mdk-worker/device')
const LuxorApi = require('./api/client')
const { parseSummary } = require('./summary')
const { SUMMARY_CACHE_MS, SUMMARY_ERROR_CACHE_MS } = require('./constants')

// WorkerRuntimeV2 loads this module once per device, so the API client and
// the cached summary below belong to the one scope this device reports.
let api
let scope
let cached = null
let inFlight = null

/** The HttpFacility shape LuxorApi was written against, over fetch. */
const http = {
  async get (url, { headers, timeout, signal, redirect }) {
    const signals = [AbortSignal.timeout(timeout), signal].filter(Boolean)
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.any(signals),
      redirect: redirect === false ? 'manual' : 'follow'
    })
    if (!res.ok) {
      await res.body?.cancel()
      const err = new Error(`HTTP ${res.status}`)
      err.status = res.status
      throw err
    }
    return { body: await res.json() }
  }
}

// Config errors surface on the first telemetry call, not at load time, so a
// misconfigured device reports an error instead of failing the whole worker.
function connect () {
  if (!api) {
    scope = LuxorApi.parseScope(opts)
    api = new LuxorApi(http, { apiKey: opts.apiKey, apiUrl: opts.apiUrl })
  }
  return api
}

/**
 * The parsed pool summary for this device's scope. Concurrent channels of
 * one metrics pull share a single request, and a result is reused for
 * SUMMARY_CACHE_MS. A failure is rethrown for SUMMARY_ERROR_CACHE_MS.
 */
async function getSummary () {
  const client = connect()
  if (cached && Date.now() - cached.at < (cached.error ? SUMMARY_ERROR_CACHE_MS : SUMMARY_CACHE_MS)) {
    if (cached.error) throw cached.error
    return cached.summary
  }
  if (!inFlight) {
    inFlight = client.getSummary(scope)
      .then(body => {
        cached = { at: Date.now(), summary: parseSummary(body) }
        return cached.summary
      }, error => {
        cached = { at: Date.now(), error }
        throw error
      })
      .finally(() => { inFlight = null })
  }
  return inFlight
}

module.exports = { getSummary }
