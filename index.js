'use strict'

module.exports = {
  plugin: require('./src/plugin'),
  startLuxorWorker: require('./src/boot').startLuxorWorker,
  LUXOR_POOL: require('./src/pool')
}
