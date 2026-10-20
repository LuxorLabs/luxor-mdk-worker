'use strict'

const { getSummary } = require('../client')

module.exports = async () => (await getSummary()).active_miners
