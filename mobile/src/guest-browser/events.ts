/**
 * Android WebView -> Electron `<webview>` event vocabulary (pure, so it is unit-tested).
 *
 * The pane reads Chromium net-error numbers from `did-fail-load` and DROPS -3 (ERR_ABORTED), so the
 * one trap here is Android's own -3 (ERROR_UNSUPPORTED_AUTH_SCHEME): it must never reach the pane
 * as -3. -3 is produced only for a navigation that was really aborted.
 */

/** Where a native failure came from. `load` is a WebViewClient.ERROR_* code. */
export type FailReason = 'abort' | 'blocked' | 'crash' | 'load' | 'ssl'

export interface NativeFail {
  /** WebViewClient.ERROR_* for `load`, SslError.SSL_* for `ssl`, ignored otherwise. */
  androidCode: number
  description: string
  reason: FailReason
}

export interface GuestLoadError {
  errorCode: number
  errorDescription: string
}

export const ERR_FAILED = -2
export const ERR_ABORTED = -3
export const ERR_BLOCKED_BY_CLIENT = -20

/** WebViewClient.ERROR_* -> [Chromium net error, name]. */
const LOAD_ERRORS: Record<number, [number, string]> = {
  [-1]: [ERR_FAILED, 'ERR_FAILED'],
  [-2]: [-105, 'ERR_NAME_NOT_RESOLVED'],
  [-3]: [-339, 'ERR_UNSUPPORTED_AUTH_SCHEME'],
  [-4]: [-338, 'ERR_INVALID_AUTH_CREDENTIALS'],
  [-5]: [-115, 'ERR_PROXY_AUTH_UNSUPPORTED'],
  [-6]: [-104, 'ERR_CONNECTION_FAILED'],
  [-7]: [-101, 'ERR_CONNECTION_RESET'],
  [-8]: [-118, 'ERR_CONNECTION_TIMED_OUT'],
  [-9]: [-310, 'ERR_TOO_MANY_REDIRECTS'],
  [-10]: [-302, 'ERR_UNKNOWN_URL_SCHEME'],
  [-11]: [-107, 'ERR_SSL_PROTOCOL_ERROR'],
  [-12]: [-300, 'ERR_INVALID_URL'],
  [-13]: [-6, 'ERR_FILE_NOT_FOUND'],
  [-14]: [-6, 'ERR_FILE_NOT_FOUND'],
  [-15]: [-12, 'ERR_INSUFFICIENT_RESOURCES'],
  [-16]: [ERR_BLOCKED_BY_CLIENT, 'ERR_BLOCKED_BY_CLIENT']
}

/** SslError.SSL_* (NOTYETVALID, EXPIRED, IDMISMATCH, UNTRUSTED, DATE_INVALID, INVALID). */
const SSL_ERRORS: Record<number, [number, string]> = {
  0: [-201, 'ERR_CERT_DATE_INVALID'],
  1: [-201, 'ERR_CERT_DATE_INVALID'],
  2: [-200, 'ERR_CERT_COMMON_NAME_INVALID'],
  3: [-202, 'ERR_CERT_AUTHORITY_INVALID'],
  4: [-201, 'ERR_CERT_DATE_INVALID'],
  5: [-207, 'ERR_CERT_INVALID']
}

export function mapLoadError({ androidCode, description, reason }: NativeFail): GuestLoadError {
  switch (reason) {
    case 'abort':
      return { errorCode: ERR_ABORTED, errorDescription: 'ERR_ABORTED' }
    case 'blocked':
      // The description is the policy's own sentence: it is what the user reads in the error card.
      return { errorCode: ERR_BLOCKED_BY_CLIENT, errorDescription: description || 'ERR_BLOCKED_BY_CLIENT' }
    case 'crash':
      return { errorCode: ERR_FAILED, errorDescription: 'The page crashed.' }
    case 'ssl': {
      const [errorCode, errorDescription] = SSL_ERRORS[androidCode] ?? SSL_ERRORS[5]!

      return { errorCode, errorDescription }
    }
    default: {
      const [errorCode, errorDescription] = LOAD_ERRORS[androidCode] ?? [ERR_FAILED, description || 'ERR_FAILED']

      return { errorCode, errorDescription }
    }
  }
}

/** android.webkit.ConsoleMessage.MessageLevel name -> Electron's 0 verbose, 1 info, 2 warning, 3 error. */
export function mapConsoleLevel(level: string): 0 | 1 | 2 | 3 {
  switch (level) {
    case 'ERROR':
      return 3
    case 'WARNING':
      return 2
    case 'LOG':
      return 1
    default:
      return 0
  }
}

/** The `ipc-message` channel the pane listens on for a `target=_blank` / window.open (preview-pane.tsx). */
export const PREVIEW_EXTERNAL_CHANNEL = 'preview-open-external'

/** Electron's wording for a loadURL() rejection, which the pane shows verbatim in its error card. */
export function loadFailureMessage(error: GuestLoadError, url: string): string {
  return `${error.errorDescription} (${error.errorCode}) loading '${url}'`
}
