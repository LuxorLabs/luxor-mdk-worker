'use strict'

const http = require('node:http')
const { parseArgs } = require('node:util')
const defaultState = require('./state')
const routes = require('./routes')

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 5066

// The slice of the `fastify` API mock/routes.js and its tests use, on node:http.
function createApp () {
  const hooks = { onRequest: [], preHandler: [] }
  const table = []

  const reply = res => {
    const r = { statusCode: 200, sent: false, code (c) { r.statusCode = c; return r } }
    r.send = body => {
      r.sent = true
      res.writeHead(r.statusCode, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    return r
  }
  // fastify answers HEAD for every GET route and 404s any other method.
  const routeOf = (method, pathname) => {
    for (const [routeMethod, pattern, handler] of table) {
      if (method !== routeMethod && !(routeMethod === 'GET' && method === 'HEAD')) continue
      const want = pattern.split('/')
      const got = pathname.split('/')
      if (want.length !== got.length) continue
      const params = {}
      want.forEach((part, i) => { if (part.startsWith(':')) params[part.slice(1)] = got[i] })
      if (want.every((part, i) => part.startsWith(':') || part === got[i])) return { handler, params }
    }
    return null
  }

  async function handle (req, res) {
    const url = new URL(req.url, 'http://mock.invalid')
    const route = routeOf(req.method, url.pathname)
    // Like fastify's parser, a repeated key becomes an array of its values.
    req.query = {}
    for (const key of new Set(url.searchParams.keys())) {
      const values = url.searchParams.getAll(key)
      req.query[key] = values.length > 1 ? values : values[0]
    }
    req.params = route ? route.params : {}
    const r = reply(res)
    for (const hook of hooks.onRequest) {
      await hook(req, r)
      if (r.sent) return
    }
    if (!route) {
      return r.code(404).send({ statusCode: 404, error: 'Not Found', message: 'Route not found' })
    }
    for (const hook of hooks.preHandler) {
      await hook(req, r)
      if (r.sent) return
    }
    const result = await route.handler(req, r)
    if (!r.sent && result !== undefined) r.send(result)
  }

  const app = {
    addHook: (name, fn) => hooks[name].push(fn),
    get: (pattern, handler) => table.push(['GET', pattern, handler]),
    register: (fn, opts = {}) => fn(app, opts),
    inject: async ({ method = 'GET', url, headers = {} }) => {
      const chunks = []
      const res = {
        statusCode: 200,
        writeHead (status) { res.statusCode = status },
        end (body) { if (body !== undefined && method !== 'HEAD') chunks.push(body) }
      }
      await handle({ method, url, headers }, res)
      const text = chunks.join('')
      return { statusCode: res.statusCode, json: () => JSON.parse(text), body: text }
    },
    close: async () => app.server.closeAllConnections() || app.server.close()
  }

  app.handle = handle
  return app
}

async function createServer (options = {}) {
  const { host = DEFAULT_HOST, port = DEFAULT_PORT, state = defaultState() } = options

  const requests = []
  const app = createApp()
  app.addHook('onRequest', async request => { requests.push(request.url) })
  await app.register(routes, { state })

  const server = http.createServer((req, res) => {
    app.handle(req, res).catch(err => {
      if (res.headersSent) {
        res.destroy(err)
        return
      }
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ statusCode: 500, error: 'Internal Server Error', message: err.message }))
    })
  })
  const close = () => new Promise((resolve, reject) => {
    server.closeAllConnections()
    server.close(err => (err && err.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(err) : resolve()))
  })
  app.server = server
  app.close = close

  try {
    await new Promise((resolve, reject) => {
      const onError = err => {
        server.removeListener('listening', onListening)
        reject(err)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    })
    return { app, state, requests, apiUrl: `http://${host}:${server.address().port}` }
  } catch (err) {
    await close()
    throw err
  }
}

async function main () {
  const { values } = parseArgs({
    options: {
      host: { type: 'string', default: DEFAULT_HOST },
      port: { type: 'string', default: String(DEFAULT_PORT) }
    }
  })

  const { app, apiUrl } = await createServer({ host: values.host, port: Number(values.port) })
  console.log(`Luxor mock listening at ${apiUrl}`)

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => app.close())
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.message)
    process.exitCode = 1
  })
}

module.exports = { createServer }
