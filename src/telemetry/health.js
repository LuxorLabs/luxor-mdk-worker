'use strict'

const { getSummary } = require('../client')

// Replaces MDK's builtin health channel, which echoes the device config
// back to any Kernel client, and the config holds the API key.
module.exports = async () => {
  try {
    await getSummary()
    return { status: 'OK' }
  } catch (err) {
    return { status: 'OFFLINE', error: /ERR_[A-Z_]+/.exec(err.message)?.[0] || 'ERR_LUXOR_API' }
  }
}
