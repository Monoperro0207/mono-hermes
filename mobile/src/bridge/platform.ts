/**
 * Native platform capabilities, backed by Capacitor plugins.
 *
 * Each factory returns plain functions typed to the corresponding slice of
 * `window.hermesDesktop`, so install.ts can spread them straight into the bridge
 * and TypeScript flags any signature drift against upstream's global.d.ts.
 * Capacitor plugins are imported lazily so unit tests never load native code.
 */

import type { AuthSession } from './auth'
import type { HttpTransport } from './http'
import { isMobileFilePath, readAsDataUrl, readDataUrl, readText, registerFile } from './local-files'
import {
  deleteCacheFiles,
  type DownloadResult,
  downloadToCache,
  downloadWithBearer,
  fetchPublicText,
  isTooLarge
} from './native-http'
import { classifyHost, errorMessage } from './util'

type HermesNotification = Parameters<Window['hermesDesktop']['notify']>[0]

type Unsubscribe = () => void
type Emitter<T> = { emit: (payload: T) => void; subscribe: (callback: (payload: T) => void) => Unsubscribe }

export function createEmitter<T>(): Emitter<T> {
  const listeners = new Set<(payload: T) => void>()

  return {
    emit: payload => {
      for (const listener of listeners) {
        try {
          listener(payload)
        } catch (error) {
          console.error('[hermes-mobile] listener failed', error)
        }
      }
    },
    subscribe: callback => {
      listeners.add(callback)

      return () => void listeners.delete(callback)
    }
  }
}

const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:'])

export async function openExternal(url: string): Promise<void> {
  let parsed: URL

  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Cannot open "${url}": not a valid URL.`)
  }

  if (!EXTERNAL_SCHEMES.has(parsed.protocol)) {
    throw new Error(`Refusing to open a ${parsed.protocol} link.`)
  }

  const { Browser } = await import('@capacitor/browser')
  await Browser.open({ url: parsed.toString() })
}

export async function writeClipboard(text: string): Promise<boolean> {
  try {
    const { Clipboard } = await import('@capacitor/clipboard')
    await Clipboard.write({ string: text })

    return true
  } catch {
    try {
      await navigator.clipboard.writeText(text)

      return true
    } catch {
      return false
    }
  }
}

export async function readClipboard(): Promise<string> {
  try {
    const { Clipboard } = await import('@capacitor/clipboard')

    return (await Clipboard.read()).value ?? ''
  } catch {
    return navigator.clipboard.readText().catch(() => '')
  }
}

/** Triggers the Android RECORD_AUDIO prompt through getUserMedia, then releases the mic. */
export async function requestMicrophoneAccess(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })

    for (const track of stream.getTracks()) {
      track.stop()
    }

    return true
  } catch {
    return false
  }
}

export type KeepAwakeMode = 'always' | 'off' | 'while-working'

/** Whether the screen should be held on for the chosen mode and the number of turns in flight. */
export function wantsKeepAwake(mode: KeepAwakeMode, activeTurns: number): boolean {
  return mode === 'always' || (mode === 'while-working' && activeTurns > 0)
}

/**
 * Keep-awake follows the user's mode: the renderer reports the mode (`setKeepAwake`) and, for
 * 'while-working', how many turns are in flight (`setActiveWork`). Only transitions touch the plugin.
 */
export function createKeepAwakeController(apply: (on: boolean) => Promise<void> = applyKeepAwake) {
  let mode: KeepAwakeMode = 'off'
  let activeTurns = 0
  let held = false

  const sync = () => {
    const next = wantsKeepAwake(mode, activeTurns)

    if (next !== held) {
      held = next
      void apply(next)
    }
  }

  return {
    setActiveWork(count: number) {
      activeTurns = Math.max(0, Math.trunc(count) || 0)
      sync()
    },
    setMode(next: KeepAwakeMode) {
      mode = next === 'always' || next === 'while-working' ? next : 'off'
      sync()
    }
  }
}

async function applyKeepAwake(on: boolean): Promise<void> {
  try {
    const { KeepAwake } = await import('@capacitor-community/keep-awake')

    if (on) {
      await KeepAwake.keepAwake()
    } else {
      await KeepAwake.allowSleep()
    }
  } catch (error) {
    console.warn('[hermes-mobile] keep-awake unavailable:', errorMessage(error))
  }
}

const keepAwake = createKeepAwakeController()

export const setKeepAwake = keepAwake.setMode
export const setActiveWork = keepAwake.setActiveWork

export interface NotificationEvents {
  focusSession: Emitter<string>
  action: Emitter<{ actionId: string; sessionId?: string }>
  activate: Emitter<{ actionId?: string; activate?: string; notifyId?: string; tag?: string }>
}

export function createNotifications(events: NotificationEvents) {
  let nextId = 1000 + Math.floor(Math.random() * 1000)
  let wired = false

  const wire = async () => {
    if (wired) {
      return
    }

    wired = true
    const { LocalNotifications } = await import('@capacitor/local-notifications')

    await LocalNotifications.addListener('localNotificationActionPerformed', event => {
      const extra = (event.notification.extra ?? {}) as Record<string, string | undefined>

      if (event.actionId && event.actionId !== 'tap') {
        events.action.emit({ actionId: event.actionId, sessionId: extra.sessionId })

        return
      }

      const focus = extra.focusSessionId || extra.sessionId

      if (focus) {
        events.focusSession.emit(focus)
      } else {
        events.activate.emit({ activate: extra.activate, notifyId: extra.notifyId, tag: extra.tag })
      }
    })
  }

  const notify = async (payload: HermesNotification): Promise<boolean> => {
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications')
      await wire()

      let permission = (await LocalNotifications.checkPermissions()).display

      if (permission === 'prompt' || permission === 'prompt-with-rationale') {
        permission = (await LocalNotifications.requestPermissions()).display
      }

      if (permission !== 'granted') {
        return false
      }

      nextId += 1

      await LocalNotifications.schedule({
        notifications: [
          {
            body: payload.body ?? '',
            extra: {
              activate: payload.activate,
              focusSessionId: payload.focusSessionId,
              notifyId: payload.notifyId,
              sessionId: payload.sessionId,
              tag: payload.tag
            },
            id: nextId,
            title: payload.title || 'Hermes'
          }
        ]
      })

      return true
    } catch (error) {
      console.warn('[hermes-mobile] notification failed:', errorMessage(error))

      return false
    }
  }

  return { notify }
}

function guessExtension(contentType: string): string {
  const type = contentType.split(';', 1)[0].trim().toLowerCase()
  const known: Record<string, string> = {
    'application/json': '.json',
    'application/pdf': '.pdf',
    'image/gif': '.gif',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'text/html': '.html',
    'text/plain': '.txt'
  }

  return known[type] ?? ''
}

function filenameFromDisposition(header: string | undefined): string {
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header ?? '')

  try {
    return match ? decodeURIComponent(match[1]) : ''
  } catch {
    return match?.[1] ?? ''
  }
}

type ShareOutcome = { path?: string; saved: boolean; canceled?: boolean }

/** Gateway files are streamed natively with this hard cap; nothing is held in JS memory. */
export const MAX_SAVE_BYTES = 1024 * 1024 * 1024
const MAX_IMAGE_SAVE_BYTES = 32 * 1024 * 1024
/** Copies left in the share folder by earlier saves are removed once they are this old. */
const SHARE_COPY_MAX_AGE_MS = 60 * 60 * 1000
const MAX_FILE_NAME_LENGTH = 120

/** Hand an app-cache file to the Android share sheet ("Save to ..."). Cancelling is not an error. */
async function shareFileUri(uri: string, title: string): Promise<ShareOutcome> {
  const { Share } = await import('@capacitor/share')

  try {
    await Share.share({ dialogTitle: 'Save or share', title, url: uri })

    return { path: uri, saved: true }
  } catch (error) {
    if (/cancel/i.test(errorMessage(error))) {
      return { canceled: true, saved: false }
    }

    throw error
  }
}

/** In-memory bytes only (`data:` images): write to the app cache, then share. Large files take the native download path. */
async function shareBase64(base64: string, filename: string): Promise<ShareOutcome> {
  const { Directory, Filesystem } = await import('@capacitor/filesystem')

  const written = await Filesystem.writeFile({ data: base64, directory: Directory.Cache, path: `downloads/${filename}` })

  return shareFileUri(written.uri, filename)
}

/** The name becomes a file in the share folder: no separators or control characters, bounded length, extension kept. */
function sanitizeFileName(raw: string, fallback: string): string {
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/\u0000-\u001f\u007f]+/g, '_')
    .replace(/^[.\s]+/, '')
    .trim()

  if (!cleaned) {
    return fallback
  }

  if (cleaned.length <= MAX_FILE_NAME_LENGTH) {
    return cleaned
  }

  const ext = /\.[a-z0-9]{1,16}$/i.exec(cleaned)?.[0] ?? ''

  return cleaned.slice(0, MAX_FILE_NAME_LENGTH - ext.length) + ext
}

const extensionOf = (name: string): string => /\.[a-z0-9]{1,10}$/i.exec(name)?.[0] ?? ''

/**
 * Share a file the native plugin already wrote. The on-disk name had to be chosen before the
 * download (from `suggestedName` or the path), so the response can only add what the name lacks:
 * when it has no extension, the one from Content-Disposition (else Content-Type, else
 * `fallbackExt`) is appended by renaming the file in place.
 */
async function shareDownload(fileName: string, result: DownloadResult, fallbackExt = ''): Promise<ShareOutcome> {
  let name = fileName
  let uri = result.uri

  if (!extensionOf(name)) {
    const ext =
      extensionOf(filenameFromDisposition(result.contentDisposition ?? undefined)) ||
      guessExtension(result.contentType ?? '') ||
      fallbackExt

    if (ext) {
      try {
        const { Directory, Filesystem } = await import('@capacitor/filesystem')

        await Filesystem.rename({ directory: Directory.Cache, from: `downloads/${name}`, to: `downloads/${name}${ext}` })
        name += ext
        uri += ext
      } catch {
        // Share it under the extension-less name rather than fail a finished download.
      }
    }
  }

  return shareFileUri(uri, name)
}

/** Best effort: drop share copies from earlier saves so the cache does not accumulate files. */
async function sweepOldCopies(): Promise<void> {
  try {
    await deleteCacheFiles({ directory: 'downloads', olderThanMs: SHARE_COPY_MAX_AGE_MS })
  } catch {
    // A failed sweep must never block a save.
  }
}

/** Native download failures worded for the user; anything else passes through untouched. */
function explainSaveError(error: unknown, what: 'file' | 'image', limit: string): unknown {
  const code = (error as { code?: unknown } | null)?.code

  if (isTooLarge(error)) {
    return new Error(`This ${what} is too large to save on the phone (over ${limit}).`)
  }

  if (code === 'insufficient_space') {
    return new Error(`Not enough free space on the phone to save this ${what}.`)
  }

  if (code === 'blocked_host') {
    return new Error('Only images from the public web or from your Hermes server can be saved.')
  }

  return error
}

export interface DownloadDeps {
  auth: AuthSession
  transport: HttpTransport
}

/**
 * `saveGatewayFile`: download from /api/fs/download (bearer), then share/save on the phone.
 * The native plugin streams the body straight into the app cache (hard cap MAX_SAVE_BYTES), so the
 * file is never Base64-encoded or held in JavaScript. The file keeps its real name (no prefix) because
 * that is the name the share sheet shows; a same-named copy younger than an hour is overwritten.
 */
export function createGatewayFileSaver({ auth }: DownloadDeps) {
  return async (payload: {
    path: string
    profile?: null | string
    sessionId?: string
    suggestedName?: string
  }): Promise<{ canceled?: boolean; path?: string; saved: boolean }> => {
    const filePath = String(payload.path || '').trim()

    if (!filePath) {
      throw new Error('Missing gateway file path')
    }

    const { pathWithProfileScope } = await import('./api')
    const session = payload.sessionId === undefined ? '' : `&session_id=${encodeURIComponent(payload.sessionId)}`
    const query = `path=${encodeURIComponent(filePath)}${session}`
    const downloadPath = pathWithProfileScope(`/api/fs/download?${query}`, payload.profile)

    const fallback = filePath.split(/[\\/]/).filter(Boolean).pop() || 'download'
    const fileName = sanitizeFileName(payload.suggestedName?.trim() || fallback, 'download')

    await sweepOldCopies()

    let result: DownloadResult

    try {
      result = await downloadWithBearer(auth, downloadPath, { directory: 'downloads', fileName, maxBytes: MAX_SAVE_BYTES })
    } catch (error) {
      throw explainSaveError(error, 'file', '1 GB')
    }

    return shareDownload(fileName, result)
  }
}

/**
 * Where an http(s) image comes from decides how it is fetched: the connected gateway gets the bearer
 * (and only the gateway ever does); any other host is downloaded `publicOnly`, so a LAN or loopback
 * address is refused natively. Failures throw, like the `fetch` this replaced.
 */
async function downloadRemoteImage(
  url: string,
  auth: Pick<AuthSession, 'requireBaseUrl' | 'withBearer'>,
  fileName: string
): Promise<DownloadResult> {
  let parsed: URL

  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Cannot save this image: not a valid URL.')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Cannot save an image from a ${parsed.protocol} URL.`)
  }

  const gateway = await auth
    .requireBaseUrl()
    .then(base => new URL(base))
    .catch(() => null)

  try {
    if (gateway && parsed.origin === gateway.origin) {
      return await downloadWithBearer(auth, `${parsed.pathname}${parsed.search}`, {
        directory: 'downloads',
        fileName,
        maxBytes: MAX_IMAGE_SAVE_BYTES
      })
    }

    const result = await downloadToCache({
      directory: 'downloads',
      fileName,
      maxBytes: MAX_IMAGE_SAVE_BYTES,
      publicOnly: true,
      url: parsed.href
    })

    if (result.status >= 400 || !result.uri) {
      throw new Error(`The image server answered ${result.status}.`)
    }

    return result
  } catch (error) {
    throw explainSaveError(error, 'image', '32 MB')
  }
}

/**
 * `saveImageFromUrl`: offer an image (data:, blob: or http) through the share sheet. `data:` and
 * `blob:` are already in memory; http(s) images are downloaded natively (no Base64 in JS).
 */
export async function saveImageFromUrl(url: string, auth: Pick<AuthSession, 'requireBaseUrl' | 'withBearer'>): Promise<boolean> {
  if (url.startsWith('data:') || url.startsWith('blob:')) {
    let base64: string
    let name = 'image'

    if (url.startsWith('data:')) {
      const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url)

      if (!match) {
        return false
      }

      base64 = match[2] ? match[3] : btoa(decodeURIComponent(match[3]))
      name += guessExtension(match[1] ?? 'image/png') || '.png'
    } else {
      const blob = await (await fetch(url)).blob()
      base64 = (await readAsDataUrl(blob)).split(',', 2)[1] ?? ''
      name += guessExtension(blob.type) || '.png'
    }

    return (await shareBase64(base64, `${Date.now()}-${name}`)).saved
  }

  await sweepOldCopies()

  const fileName = `${Date.now()}-image`
  const result = await downloadRemoteImage(url, auth, fileName)

  return (await shareDownload(fileName, result, '.png')).saved
}

export function saveImageBuffer(data: ArrayBuffer | Uint8Array, ext: string, name?: string): Promise<string> {
  const extension = ext.startsWith('.') ? ext : `.${ext}`
  const filename = (name?.trim() || `image-${Date.now()}`).replace(/\.[a-z0-9]+$/i, '') + extension
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)

  return Promise.resolve(registerFile(new Blob([bytes as BlobPart]), filename))
}

const LINK_TITLE_MAX_REDIRECTS = 3
const LINK_TITLE_MAX_BYTES = 64 * 1024

/**
 * Link titles are fetched with the phone's own network identity, so only public web hosts
 * qualify: http(s) to a hostname that is neither loopback, Tailscale nor LAN. IPv6 literals
 * are refused outright. This is only the cheap first gate on the URL text; the native plugin
 * resolves DNS itself, rejects any answer that is not a public address and connects only to the
 * addresses it validated (every redirect hop included), so a public name that resolves or
 * rebinds to a private address is refused with `blocked_host`.
 */
function publicWebUrl(raw: string): URL | null {
  let parsed: URL

  try {
    parsed = new URL(raw)
  } catch {
    return null
  }

  const webScheme = parsed.protocol === 'http:' || parsed.protocol === 'https:'
  const bareHost = !parsed.hostname.startsWith('[') && !parsed.username && !parsed.password

  return webScheme && bareHost && classifyHost(parsed.hostname) === 'public' ? parsed : null
}

export async function fetchLinkTitle(url: string): Promise<string> {
  const target = publicWebUrl(url)

  if (!target) {
    return ''
  }

  try {
    // The cap is enforced natively while reading, so at most LINK_TITLE_MAX_BYTES ever cross the bridge.
    const page = await fetchPublicText({
      accept: 'text/html',
      maxBytes: LINK_TITLE_MAX_BYTES,
      maxRedirects: LINK_TITLE_MAX_REDIRECTS,
      url: target.href
    })

    const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(page.text)

    return match ? match[1].replace(/\s+/g, ' ').trim() : ''
  } catch {
    return ''
  }
}

export function createLocalFileReaders(maxBytes: () => number) {
  return {
    readFileDataUrl: (path: string) => readDataUrl(path, maxBytes()),
    readFileDataUrlForAttach: (path: string) => readDataUrl(path),
    readFileText: (path: string) => {
      if (!isMobileFilePath(path)) {
        return Promise.reject(new Error('Only files chosen on this phone can be previewed here.'))
      }

      return readText(path)
    }
  }
}
