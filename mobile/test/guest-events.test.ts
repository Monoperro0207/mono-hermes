import { describe, expect, it } from 'vitest'

import {
  ERR_ABORTED,
  ERR_BLOCKED_BY_CLIENT,
  loadFailureMessage,
  mapConsoleLevel,
  mapLoadError
} from '../src/guest-browser/events'

const load = (androidCode: number) => mapLoadError({ androidCode, description: '', reason: 'load' })

describe('guest load-error mapping', () => {
  it('never turns an Android error into ERR_ABORTED (-3), which the pane drops silently', () => {
    for (let code = -16; code <= 0; code++) {
      expect(load(code).errorCode).not.toBe(ERR_ABORTED)
    }

    // Android's own -3 is ERROR_UNSUPPORTED_AUTH_SCHEME.
    expect(load(-3)).toEqual({ errorCode: -339, errorDescription: 'ERR_UNSUPPORTED_AUTH_SCHEME' })
  })

  it('produces -3 only for a real abort', () => {
    expect(mapLoadError({ androidCode: -2, description: '', reason: 'abort' }).errorCode).toBe(ERR_ABORTED)
  })

  it.each([
    [-2, -105, 'ERR_NAME_NOT_RESOLVED'],
    [-6, -104, 'ERR_CONNECTION_FAILED'],
    [-8, -118, 'ERR_CONNECTION_TIMED_OUT'],
    [-9, -310, 'ERR_TOO_MANY_REDIRECTS'],
    [-10, -302, 'ERR_UNKNOWN_URL_SCHEME'],
    [-12, -300, 'ERR_INVALID_URL'],
    [-16, ERR_BLOCKED_BY_CLIENT, 'ERR_BLOCKED_BY_CLIENT']
  ])('maps WebViewClient %i to net error %i', (code, errorCode, errorDescription) => {
    expect(load(code)).toEqual({ errorCode, errorDescription })
  })

  it('falls back to ERR_FAILED for codes it does not know', () => {
    expect(load(-99).errorCode).toBe(-2)
    expect(load(7).errorCode).toBe(-2)
  })

  it('maps policy refusals to ERR_BLOCKED_BY_CLIENT and keeps the sentence for the error card', () => {
    expect(mapLoadError({ androidCode: 0, description: 'Use https.', reason: 'blocked' })).toEqual({
      errorCode: ERR_BLOCKED_BY_CLIENT,
      errorDescription: 'Use https.'
    })
  })

  it('maps TLS failures and crashes', () => {
    expect(mapLoadError({ androidCode: 3, description: '', reason: 'ssl' }).errorCode).toBe(-202)
    expect(mapLoadError({ androidCode: 2, description: '', reason: 'ssl' }).errorCode).toBe(-200)
    expect(mapLoadError({ androidCode: 99, description: '', reason: 'ssl' }).errorCode).toBe(-207)
    expect(mapLoadError({ androidCode: 0, description: '', reason: 'crash' }).errorCode).toBe(-2)
  })

  it('words a loadURL rejection like Electron', () => {
    expect(loadFailureMessage({ errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED' }, 'https://x.test/')).toBe(
      "ERR_NAME_NOT_RESOLVED (-105) loading 'https://x.test/'"
    )
  })
})

describe('console level mapping', () => {
  it.each([
    ['ERROR', 3],
    ['WARNING', 2],
    ['LOG', 1],
    ['DEBUG', 0],
    ['TIP', 0],
    ['', 0]
  ])('%s -> %i', (level, expected) => {
    expect(mapConsoleLevel(level)).toBe(expected)
  })
})
