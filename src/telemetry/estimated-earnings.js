'use strict'

const { getSummary } = require('../client')

module.exports = async () => (await getSummary()).revenue_24h
