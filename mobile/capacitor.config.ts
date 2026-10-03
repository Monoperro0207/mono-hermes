import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Notes on the choices that matter for talking to a `hermes serve` gateway:
 *
 * - androidScheme "http" -> the WebView origin is http://localhost. The gateway's
 *   CORS allow-list and its WebSocket Origin guard both accept http://localhost
 *   (and only that kind of origin), and a plain-http page can open ws:// sockets
 *   to a Tailscale IP without mixed-content blocking.
 * - Cleartext traffic to the PC is permitted by android/app/src/main/res/xml/
 *   network_security_config.xml; the app itself restricts it to Tailscale / LAN /
 *   loopback hosts (src/bridge/util.ts assertTransportAllowed).
 * - CapacitorHttp stays OFF globally: the bridge calls it explicitly where a native
 *   request is needed (login + REST); patching every fetch would break streaming
 *   responses the renderer relies on.
 */
const config: CapacitorConfig = {
  android: {
    allowMixedContent: false,
    // The desktop renderer uses modern CSS (Tailwind 4: @layer, color-mix, oklch).
    minWebViewVersion: 111,
    webContentsDebuggingEnabled: process.env.HERMES_MOBILE_WEBVIEW_DEBUG === '1'
  },
  appId: 'com.hermesmovil.app',
  appName: 'Mono Hermes',
  backgroundColor: '#0a0a0a',
  plugins: {
    CapacitorHttp: { enabled: false },
    SystemBars: { insetsHandling: 'css', style: 'DARK' }
  },
  server: {
    androidScheme: 'http',
    hostname: 'localhost'
  },
  webDir: 'dist'
}

export default config
