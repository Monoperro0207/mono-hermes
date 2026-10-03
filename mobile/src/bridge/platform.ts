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
import { errorMessage } from './util'

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

/** Write bytes to the app cache and hand them to the Android share sheet ("Save to ..."). */
async function shareBase64(base64: string, filename: string): Promise<{ path?: string; saved: boolean; canceled?: boolean }> {
  const { Directory, Filesystem } = await import('@capacitor/filesystem')
  const { Share } = await import('@capacitor/share')

  const written = await Filesystem.writeFile({ data: base64, directory: Directory.Cache, path: `downloads/${filename}` })

  try {
    await Share.share({ dialogTitle: 'Save or share', title: filename, url: written.uri })

    return { path: written.uri, saved: true }
  } catch (error) {
    if (/cancel/i.test(errorMessage(error))) {
      return { canceled: true, saved: false }
    }

    throw error
  }
}

export interface DownloadDeps {
  auth: AuthSession
  transport: HttpTransport
}

/** `saveGatewayFile`: download from /api/fs/download (bearer), then share/save on the phone. */
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

    const { CapacitorHttp } = await import('@capacitor/core')

    const response = await auth.withBearer(async (token, baseUrl) => {
      const result = await CapacitorHttp.request({
        headers: { Authorization: `Bearer ${token}` },
        method: 'GET',
        responseType: 'blob',
        url: `${baseUrl}${downloadPath}`
      })

      if (result.status >= 400) {
        const { HttpStatusError } = await import('./http')

        throw new HttpStatusError(result.status, typeof result.data === 'string' ? result.data : '')
      }

      return result
    })

    const headers = Object.fromEntries(Object.entries(response.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]))
    const fallback = filePath.split(/[\\/]/).filter(Boolean).pop() || 'download'

    const filename =
      payload.suggestedName?.trim() ||
      filenameFromDisposition(headers['content-disposition']) ||
      fallback + (fallback.includes('.') ? '' : guessExtension(headers['content-type'] ?? ''))

    return shareBase64(String(response.data ?? ''), filename)
  }
}

/** `saveImageFromUrl`: fetch an image (data: or http) and offer it through the share sheet. */
export async function saveImageFromUrl(url: string): Promise<boolean> {
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

  const result = await shareBase64(base64, `${Date.now()}-${name}`)

  return result.saved
}

export function saveImageBuffer(data: ArrayBuffer | Uint8Array, ext: string, name?: string): Promise<string> {
  const extension = ext.startsWith('.') ? ext : `.${ext}`
  const filename = (name?.trim() || `image-${Date.now()}`).replace(/\.[a-z0-9]+$/i, '') + extension
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)

  return Promise.resolve(registerFile(new Blob([bytes as BlobPart]), filename))
}

export async function fetchLinkTitle(url: string): Promise<string> {
  try {
    const { CapacitorHttp } = await import('@capacitor/core')
    const response = await CapacitorHttp.get({ headers: { Accept: 'text/html' }, readTimeout: 6000, connectTimeout: 4000, url })
    const html = typeof response.data === 'string' ? response.data.slice(0, 64 * 1024) : ''
    const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)

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
