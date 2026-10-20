'use strict'

const { createServer } = require('./mock/server')
const keys = require('./mock/keys')

module.exports = {
  async setup () {
    const server = await createServer({ port: 0 })
    return {
      deviceId: 'luxor-0',
      config: { apiKey: keys.apiKey, apiUrl: server.apiUrl, subaccounts: ['mock-sub-1', 'mock-sub-2'] },
      teardown: () => server.app.close()
    }
  }
}
