'use strict'

/**
 * The only error type the API client throws for transport and payload
 * problems. It does not wrap the original HTTP error, because that object
 * can carry the authorization header.
 */
class LuxorApiError extends Error {
  constructor (path, status, code) {
    super(`ERR_LUXOR_API ${path} ${status} ${code}`)
    this.path = path
    this.status = status
    this.code = code
  }

  static transport (path, err) {
    return new LuxorApiError(path, err.status || 0, 'REQUEST_FAILED')
  }

  /** The server answered, but the payload does not fit the documented shape. */
  static payload (path, code) {
    return new LuxorApiError(path, 200, code)
  }
}

/** A field in an otherwise valid response is missing or malformed. */
class DataError extends Error {
  constructor (field) {
    super(`ERR_LUXOR_DATA ${field}`)
    this.field = field
  }
}

/** The stable code at the start of an error, for the health channel. */
function errorCode (err) {
  return /\bE(RR)?_[A-Z_]+/.exec(err?.message)?.[0] || 'ERR_LUXOR_API'
}

module.exports = { LuxorApiError, DataError, errorCode }
