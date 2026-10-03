/**
 * global.d.ts reaches into two Electron main-process modules for plain TYPE
 * declarations (MachineProfile, GrowRequest). Those files `import 'electron'`,
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
}
