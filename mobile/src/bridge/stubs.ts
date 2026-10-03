/**
 * Desktop-only surface of `window.hermesDesktop`.
 *
 * Everything here belongs to the Electron shell and has no meaning on a phone:
 * local backend lifecycle and bootstrap, auto-update, terminals, git/filesystem
 * access on the host, extra OS windows, overlays and HUDs, the Cloud portal.
 *
 * Rules the stubs follow so the unmodified renderer degrades quietly instead of
 * throwing at boot:
 *  - methods the renderer calls during startup resolve to "nothing to see" values;
 *  - methods that start a desktop-only action reject with a clear
 *    "not supported on mobile" error (surfaced by the renderer as a toast);
 *  - subscriptions return a no-op unsubscribe;
 *  - optional members (hud, zoom, wakeIndicator, ...) are simply left out so
 *    feature detection in the renderer turns those features off.
 *
 * `StubSurface` is derived from upstream's global.d.ts: when upstream adds a
 * required member, `tsc` fails here and tells us to decide how it behaves.
 */

export type DesktopBridge = Window['hermesDesktop']

/** Required members that install.ts implements for real (see install.ts). */
export type ImplementedKeys =
  | 'api'
  | 'claimAmbientCue'
  | 'fetchLinkTitle'
  | 'getConnection'
  | 'getConnectionFor'
  | 'getGatewayWsUrl'
  | 'getGatewayWsUrlFor'
  | 'getPathForFile'
  | 'getProfileRoutes'
  | 'getRecentLogs'
  | 'getVersion'
  | 'notify'
  | 'onBackendExit'
  | 'onConnectionApplied'
  | 'onFocusSession'
  | 'onNotificationAction'
  | 'onNotificationActivate'
  | 'onPowerResume'
  | 'openExternal'
  | 'probeConnectionConfig'
  | 'oauthLoginConnectionConfig'
  | 'oauthLogoutConnectionConfig'
  | 'connections'
  | 'getConnectionConfig'
  | 'saveConnectionConfig'
  | 'applyConnectionConfig'
  | 'testConnectionConfig'
  | 'readClipboard'
  | 'readFileDataUrl'
  | 'readFileDataUrlForAttach'
  | 'readFileText'
  | 'requestMicrophoneAccess'
  | 'revalidateConnection'
  | 'saveGatewayFile'
  | 'saveImageBuffer'
  | 'saveImageFromUrl'
  | 'savePastedText'
  | 'selectPaths'
  | 'setKeepAwake'
  | 'writeClipboard'

export type Implemented = Pick<DesktopBridge, ImplementedKeys>

export type StubSurface = Omit<DesktopBridge, ImplementedKeys | 'hud' | 'zoom' | 'wakeIndicator'>

const noopUnsubscribe = (): (() => void) => () => undefined

const unsupported = (feature: string) => (): Promise<never> =>
  Promise.reject(new Error(`${feature} is not supported on mobile.`))

export function createStubs(): StubSurface {
  const stubs: StubSurface = {
    // --- local backend / pool lifecycle (the PC owns the backend) -------------
    cancelBootstrap: async () => ({ cancelled: false, ok: true }),
    continueBootstrapLocal: async () => ({ ok: true }),
    getBootProgress: async () => ({
      error: null,
      fakeMode: false,
      message: 'Ready',
      phase: 'ready',
      progress: 1,
      running: false,
      timestamp: Date.now()
    }),
    getBootstrapState: async () => ({
      active: false,
      bundled: false,
      completedAt: null,
      error: null,
      log: [],
      manifest: null,
      setupChoice: null,
      stages: {},
      startedAt: null,
      unsupportedPlatform: null
    }),
    getPoolLimits: async () => ({ idleMs: 10 * 60_000, maxBackends: 3 }),
    onBootProgress: noopUnsubscribe,
    onBootstrapEvent: noopUnsubscribe,
    repairBootstrap: async () => ({ ok: false }),
    resetBootstrap: async () => ({ ok: false }),
    setPoolLimits: async limits => ({
      limits: { idleMs: limits.idleMs ?? 10 * 60_000, maxBackends: limits.maxBackends ?? 3 },
      ok: true
    }),
    touchBackend: async () => ({ ok: true }),

    // --- registry / profiles / secrets ---------------------------------------
    cloud: {
      agentSignIn: unsupported('Hermes Cloud'),
      discover: async () => ({ agents: [] }),
      login: unsupported('Hermes Cloud'),
      logout: async () => ({ ok: true, portalBaseUrl: '', signedIn: false }),
      status: async () => ({ portalBaseUrl: '', signedIn: false })
    },
    getSecretStorageEncryption: async () => ({ on: false }),
    profile: {
      get: async () => ({ profile: null }),
      getDefault: async () => null,
      onDefaultChanged: noopUnsubscribe,
      remember: async name => ({ profile: name }),
      set: async name => ({ profile: name }),
      setDefault: async route => route
    },
    setSecretStorageEncryption: async () => ({ on: false }),
    sshConfigHosts: async () => ({ hosts: [] }),
    sshResolveHost: async () => ({ hostname: null, identityFile: null, port: null, user: null }),

    // --- extra windows, overlays, HUD, quick entry ---------------------------
    onBrowserPopoutClosed: noopUnsubscribe,
    openBrowserWindow: async () => ({ error: 'windows-unsupported', ok: false }),
    openSessionInTerminal: async () => ({ error: 'terminal-unsupported', ok: false }),
    openSessionWindow: async () => ({ error: 'windows-unsupported', ok: false }),
    openWindow: async () => ({ error: 'windows-unsupported', ok: false }),
    petOverlay: {
      close: async () => ({ ok: true }),
      control: () => undefined,
      onControl: noopUnsubscribe,
      onState: noopUnsubscribe,
      open: async () => ({ ok: false }),
      pushState: () => undefined,
      setBounds: () => undefined,
      setFocusable: () => undefined,
      setIgnoreMouse: () => undefined
    },
    quickEntry: {
      ackSubmit: () => undefined,
      dismiss: () => undefined,
      getSettings: async () => ({ enabled: false, error: null, registered: false, shortcut: '' }),
      onLateResult: noopUnsubscribe,
      onShown: noopUnsubscribe,
      onState: noopUnsubscribe,
      onSubmit: noopUnsubscribe,
      pushState: () => undefined,
      setSettings: async () => ({ enabled: false, error: null, registered: false, shortcut: '' }),
      submit: async () => ({ code: 'unsupported', message: 'Quick entry is a desktop feature.', ok: false })
    },

    // --- local filesystem / git / terminal on the host ------------------------
    normalizePreviewTarget: async target => {
      if (!/^https?:\/\//i.test(target)) {
        return null
      }

      let label = target

      try {
        label = new URL(target).host
      } catch {
        // keep the raw string
      }

      return { kind: 'url', label, source: target, url: target }
    },
    onPreviewFileChanged: noopUnsubscribe,
    readDir: async () => ({ entries: [], error: 'Browsing files on the phone is not supported.' }),
    revealLogs: async () => ({ error: 'Not supported on mobile.', ok: false, path: '' }),
    sanitizeWorkspaceCwd: async cwd => ({ cwd: cwd ?? '', sanitized: false }),
    saveClipboardImage: async () => '',
    settings: {
      getDefaultProjectDir: async () => ({ defaultLabel: '', dir: null, resolvedCwd: '' }),
      pickDefaultProjectDir: async () => ({ canceled: true, dir: null }),
      setDefaultProjectDir: async dir => ({ dir })
    },
    stopPreviewFileWatch: async () => true,
    terminal: {
      attach: async () => false,
      cwd: async () => null,
      dispose: async () => false,
      onData: noopUnsubscribe,
      onExit: noopUnsubscribe,
      resize: async () => false,
      start: unsupported('The terminal pane'),
      write: async () => false
    },
    watchPreviewFile: async () => ({ id: '', path: '' }),

    // --- app lifecycle, updates, uninstall, themes ----------------------------
    getSyncStatus: async () => null,
    windowControls: { close: () => undefined, custom: false, minimize: () => undefined, toggleMaximize: () => undefined },
    findInPage: async () => ({ count: 0 }),
    onFoundInPage: noopUnsubscribe,
    onOpenFindBarRequested: noopUnsubscribe,
    stopFindInPage: async () => undefined,
    themes: {
      fetchMarketplace: unsupported('The VS Code theme marketplace'),
      searchMarketplace: async () => []
    },
    uninstall: {
      run: async () => ({ error: 'Uninstall the app from Android settings.', ok: false }),
      summary: async () => ({
        agent_installed: false,
        code_removal_allowed: false,
        gui_installed: true,
        hermes_home: '',
        packaged_app_paths: [],
        platform: 'android',
        source_built_artifacts: [],
        userdata_dir: '',
        userdata_exists: false
      })
    },
    updates: {
      apply: async () => ({
        error: 'Update Hermes on the PC with "hermes update"; update this app by installing a newer APK.',
        ok: false
      }),
      check: async () => ({ reason: 'mobile', supported: false }),
      getBranch: async () => ({ branch: 'main' }),
      onProgress: noopUnsubscribe,
      setBranch: async branch => ({ branch })
    }
  }

  return stubs
}
