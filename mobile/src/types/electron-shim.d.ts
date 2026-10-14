/**
 * global.d.ts reaches into two Electron main-process modules for plain TYPE
 * declarations (MachineProfile, ChallengeOutcome). Those files `import 'electron'`,
 * which is intentionally not installed here; this minimal ambient module is just
 * enough for `tsc -p mobile` to read the types it actually needs.
 */
declare module 'electron' {
  export interface Rectangle {
    height: number
    width: number
    x: number
    y: number
  }

  export const app: any
  export const ipcMain: any

  // challenge-window.ts: loose shapes, only so its callbacks get contextual parameter types.
  type Listener = (event: any, ...args: any[]) => void

  export interface WebContents {
    on(event: string, listener: Listener): void
    setAudioMuted(muted: boolean): void
    setWindowOpenHandler(handler: (details: any) => any): void
  }

  export interface BrowserWindow {
    readonly webContents: WebContents
    destroy(): void
    focus(): void
    isDestroyed(): boolean
    loadURL(url: string): Promise<void>
    on(event: string, listener: Listener): void
    show(): void
  }

  export type BrowserWindowConstructorOptions = Record<string, any>

  export interface Session {
    on(event: string, listener: Listener): void
    setPermissionCheckHandler(handler: (...args: any[]) => boolean): void
    setPermissionRequestHandler(handler: (contents: any, permission: string, callback: (granted: boolean) => void) => void): void
  }
}
