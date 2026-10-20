'use strict'

const { getSummary } = require('../client')
const { errorCode } = require('../errors')

// Replaces MDK's builtin health channel, which echoes the device config
// back to any Kernel client, and the config holds the API key.
module.exports = async () => {
  try {
    await getSummary()
    return { status: 'OK' }
  } catch (err) {
    return { status: 'OFFLINE', error: errorCode(err) }
  }
}
