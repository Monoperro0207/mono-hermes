/**
 * Assembles `window.hermesDesktop` for the phone.
 *
 * `buildBridge()` is the typed composition root: the object literal is checked
 * against upstream's `Window['hermesDesktop']`, so a new required member upstream
 * is a compile error here (drift detection), and each concern lives in its own
 * module (api, auth, gateway-ws, platform, stubs).
 */

import type { GatewayWsUrlResult } from '@hermes/shared'
import type {
  DesktopConnectionConfig,
  DesktopConnectionProbeResult,
  DesktopConnectionsRegistry,
  DesktopRegistryConnection,
  HermesConnection
} from '@/global'

import { createApi } from './api'
import { AuthSession, NeedsLoginError, probeServer } from './auth'
import { ConnectionStore } from './connection'
import { getGatewayWsUrl } from './gateway-ws'
import { type HttpTransport } from './http'
import { pickFiles, registerFile } from './local-files'
import {
  createEmitter,
  createGatewayFileSaver,
  createLocalFileReaders,
  createNotifications,
  fetchLinkTitle,
  openExternal,
  readClipboard,
  requestMicrophoneAccess,
  saveImageBuffer,
  saveImageFromUrl,
  setKeepAwake,
  writeClipboard
} from './platform'
import { createStubs, type DesktopBridge, type Implemented } from './stubs'
import { errorMessage, wsBaseUrl } from './util'

export const REMOTE_CONNECTION_ID = 'phone-gateway'

export interface BridgeOptions {
  /** HTTP transport (native on device, fetch in node tests). */
  transport: HttpTransport
  store: ConnectionStore
  /**
   * Ask the user for credentials (connect screen). Resolves true once signed in.
   * Absent in headless tests, where auth failures simply reject.
   */
  promptLogin?: (request: { baseUrl?: string; reason?: string }) => Promise<boolean>
  appVersion?: string
  /** Data-URL cap for locally attached files, bytes. */
  maxAttachBytes?: number
}

export interface BridgeRuntime {
  bridge: DesktopBridge
  auth: AuthSession
  /** Tell the renderer the connection changed so it wipes gateway state and re-dials. */
  announceConnectionApplied: () => void
  announcePowerResume: () => void
  announceBackendExit: (code?: number | null) => void
  log: (line: string) => void
}

export function buildBridge(options: BridgeOptions): BridgeRuntime {
  const { store, transport } = options
  const auth = new AuthSession(store, transport)
  const api = createApi({ auth, transport })

  const logs: string[] = []

  const log = (line: string) => {
    logs.push(`${new Date().toISOString()} ${line}`)

    if (logs.length > 500) {
      logs.shift()
    }
  }

  const connectionApplied = createEmitter<void>()
  const powerResume = createEmitter<void>()
  const backendExit = createEmitter<{ code: number | null; signal: string | null }>()
  const focusSession = createEmitter<string>()
  const notificationAction = createEmitter<{ actionId: string; sessionId?: string }>()
  const notificationActivate = createEmitter<{ actionId?: string; activate?: string; notifyId?: string; tag?: string }>()

  // One login overlay at a time, however many calls fail at once.
  let loginInFlight: Promise<boolean> | null = null

  const requestLogin = (request: { baseUrl?: string; reason?: string } = {}): Promise<boolean> => {
    if (!options.promptLogin) {
      return Promise.resolve(false)
    }

    loginInFlight ??= options.promptLogin(request).finally(() => {
      loginInFlight = null
    })

    return loginInFlight
  }

  /** Auth failures pop the connect screen; success re-homes the renderer. */
  const guardAuth = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (error) {
      if (error instanceof NeedsLoginError) {
        log(`auth lost: ${error.message}`)
        void requestLogin({ reason: error.message }).then(ok => ok && connectionApplied.emit())
      }

      throw error
    }
  }

  const describeConnection = async (): Promise<HermesConnection> => {
    const stored = await store.getConnection()

    if (!stored || !(await store.getTokens())) {
      void requestLogin({ baseUrl: stored?.baseUrl, reason: stored ? 'Sign in to continue.' : undefined }).then(
        ok => ok && connectionApplied.emit()
      )

      throw new NeedsLoginError(stored ? 'Sign in to your Hermes server to continue.' : 'Connect to your Hermes server first.')
    }

    const url = new URL(stored.baseUrl)

    return {
      authMode: 'oauth',
      baseUrl: stored.baseUrl,
      connectionId: REMOTE_CONNECTION_ID,
      isFullscreen: false,
      logs: [],
      mode: 'remote',
      nativeOverlayWidth: 0,
      remoteHermesVersion: stored.version,
      remoteHost: url.host,
      remoteIdentity: stored.baseUrl,
      remoteKind: 'url',
      sharedRemote: true,
      source: 'settings',
      token: '',
      windowButtonPosition: null,
      wsUrl: `${wsBaseUrl(stored.baseUrl)}/api/ws`
    }
  }

  const wsUrl = (): Promise<GatewayWsUrlResult> => guardAuth(() => getGatewayWsUrl({ auth, transport }))

  const registry = async (): Promise<DesktopConnectionsRegistry> => {
    const stored = await store.getConnection()
    const signedIn = await store.isSignedIn()

    const connections: DesktopRegistryConnection[] = stored
      ? [
          {
            authMode: 'oauth',
            id: REMOTE_CONNECTION_ID,
            kind: 'remote',
            label: new URL(stored.baseUrl).host,
            tokenPreview: null,
            tokenSet: signedIn,
            url: stored.baseUrl
          }
        ]
      : []

    return {
      connections,
      launchMode: 'primary',
      primary: stored ? REMOTE_CONNECTION_ID : '',
      secureTokenStorage: true,
      version: 2
    }
  }

  const configFor = async (): Promise<DesktopConnectionConfig> => {
    const stored = await store.getConnection()

    return {
      cloudOrg: '',
      envOverride: false,
      mode: 'remote',
      profile: null,
      remoteAuthMode: 'oauth',
      remoteOauthConnected: await store.isSignedIn(),
      remoteTokenPlainText: false,
      remoteTokenPreview: null,
      remoteTokenSet: false,
      remoteUrl: stored?.baseUrl ?? '',
      secureTokenStorage: true,
      sshHost: '',
      sshKeyPath: '',
      sshPort: null,
      sshRemoteHermesPath: '',
      sshRemoteProfile: '',
      sshUser: ''
    }
  }

  const probe = async (remoteUrl: string): Promise<DesktopConnectionProbeResult> => {
    try {
      const result = await probeServer(transport, remoteUrl)

      return {
        authMode: result.authRequired ? 'oauth' : 'token',
        baseUrl: result.baseUrl,
        error: null,
        providers: result.providers.map(p => ({
          displayName: p.displayName,
          name: p.name,
          supportsPassword: p.supportsPassword
        })),
        reachable: true,
        version: result.version
      }
    } catch (error) {
      return {
        authMode: 'unknown',
        baseUrl: remoteUrl,
        error: errorMessage(error),
        providers: [],
        reachable: false,
        version: null
      }
    }
  }

  /** Point the app at a (possibly different) server; credentials must be re-entered. */
  const retarget = async (remoteUrl: string | undefined): Promise<void> => {
    const stored = await store.getConnection()
    const next = remoteUrl?.trim()

    if (!next) {
      return
    }

    const result = await probe(next)

    if (!result.reachable) {
      throw new Error(result.error || 'Could not reach that server.')
    }

    if (stored?.baseUrl === result.baseUrl) {
      return
    }

    await store.clear()
    await store.setConnection({ baseUrl: result.baseUrl, provider: '', username: stored?.username ?? '', version: result.version ?? undefined })
  }

  const notifications = createNotifications({
    action: notificationAction,
    activate: notificationActivate,
    focusSession
  })

  const files = createLocalFileReaders(() => options.maxAttachBytes ?? 16 * 1024 * 1024)
  const saveGatewayFile = createGatewayFileSaver({ auth, transport })

  const implemented: Implemented = {
    api: <T,>(request: Parameters<DesktopBridge['api']>[0]) => guardAuth(() => api<T>(request)),
    applyConnectionConfig: async payload => {
      await retarget(payload.remoteUrl)
      connectionApplied.emit()

      return configFor()
    },
    claimAmbientCue: async () => true,
    connections: {
      list: registry,
      onChanged: () => () => undefined,
      remove: async () => {
        await store.clear()
        connectionApplied.emit()

        return { ok: true, registry: await registry() }
      },
      save: async payload => {
        await retarget(payload.url)
        const next = await registry()

        return { connection: next.connections[0], ok: true, registry: next }
      },
      setPrimary: async () => ({ ok: true, registry: await registry() }),
      test: async () => {
        const stored = await store.getConnection()
        const result = await probe(stored?.baseUrl ?? '')

        return { baseUrl: result.baseUrl, error: result.error, ok: result.reachable, reachable: result.reachable, version: result.version }
      }
    },
    fetchLinkTitle,
    getConnection: () => describeConnection(),
    getConnectionConfig: () => configFor(),
    getConnectionFor: () => describeConnection(),
    getGatewayWsUrl: () => wsUrl(),
    getGatewayWsUrlFor: () => wsUrl(),
    getPathForFile: file => registerFile(file, file.name),
    getProfileRoutes: async profiles =>
      profiles.map(profile => ({
        connectionId: REMOTE_CONNECTION_ID,
        mode: 'remote' as const,
        profile,
        targetProfile: profile
      })),
    getRecentLogs: async () => ({ lines: [...logs], path: 'in-memory' }),
    getVersion: async () => ({
      appVersion: options.appVersion ?? '0.1.0',
      electronVersion: 'capacitor-android',
      hermesRoot: '',
      nodeVersion: '',
      platform: 'android'
    }),
    notify: payload => notifications.notify(payload),
    oauthLoginConnectionConfig: async remoteUrl => {
      const ok = await requestLogin({ baseUrl: remoteUrl })

      if (ok) {
        connectionApplied.emit()
      }

      return { baseUrl: (await store.getConnection())?.baseUrl ?? remoteUrl, connected: ok, ok }
    },
    oauthLogoutConnectionConfig: async () => {
      await auth.signOut()
      connectionApplied.emit()
      void requestLogin({ reason: 'Signed out.' }).then(ok => ok && connectionApplied.emit())

      return { connected: false, ok: true }
    },
    onBackendExit: backendExit.subscribe,
    onConnectionApplied: connectionApplied.subscribe,
    onFocusSession: focusSession.subscribe,
    onNotificationAction: notificationAction.subscribe,
    onNotificationActivate: notificationActivate.subscribe,
    onPowerResume: powerResume.subscribe,
    openExternal,
    probeConnectionConfig: probe,
    readClipboard,
    readFileDataUrl: files.readFileDataUrl,
    readFileDataUrlForAttach: files.readFileDataUrlForAttach,
    readFileText: files.readFileText,
    requestMicrophoneAccess,
    revalidateConnection: async () => {
      try {
        const stored = await store.getConnection()

        if (stored) {
          await transport.request({ timeoutMs: 5_000, url: `${stored.baseUrl}/api/health` })
        }

        return { ok: true, rebuilt: false }
      } catch {
        return { ok: false, rebuilt: false }
      }
    },
    saveConnectionConfig: async payload => {
      await retarget(payload.remoteUrl)

      return configFor()
    },
    saveGatewayFile,
    saveImageBuffer,
    saveImageFromUrl,
    savePastedText: async text => registerFile(new Blob([text], { type: 'text/plain' }), `pasted-${Date.now()}.txt`),
    selectPaths: options => pickFiles(options),
    setKeepAwake: on => void setKeepAwake(on),
    testConnectionConfig: async payload => {
      const result = await probe(payload.remoteUrl ?? (await store.getConnection())?.baseUrl ?? '')

      return {
        baseUrl: result.baseUrl,
        error: result.error,
        ok: result.reachable && result.authMode !== 'unknown',
        reachable: result.reachable,
        version: result.version
      }
    },
    writeClipboard
  }

  const bridge: DesktopBridge = { ...createStubs(), ...implemented }

  return {
    announceBackendExit: code => backendExit.emit({ code: code ?? null, signal: null }),
    announceConnectionApplied: () => connectionApplied.emit(),
    announcePowerResume: () => powerResume.emit(),
    auth,
    bridge,
    log
  }
}

/** Install on `window` before the renderer boots. */
export function installBridge(options: BridgeOptions): BridgeRuntime {
  const runtime = buildBridge(options)

  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: runtime.bridge, writable: true })

  return runtime
}
