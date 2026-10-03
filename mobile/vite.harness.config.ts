/**
 * Developer harness: run the REAL renderer + bridge in a desktop browser against a
 * throwaway, isolated, gated `hermes serve` - no phone needed.
 *
 *   cd mobile && npx vite build && npx vite preview --config vite.harness.config.ts
 *   open http://localhost:4176/__harness   (signs in, reloads the app)
 *
 * What it does on top of the production build:
 *  - starts the throwaway server (test/support/throwaway-server.ts) and signs in
 *    through the production auth code;
 *  - exposes it under the same origin at /gw (reverse proxy, WebSocket included) -
 *    a desktop browser cannot do what Capacitor's native HTTP does (no CORS, raw
 *    Set-Cookie, no redirect following), so the proxy stands in for that;
 *  - /__harness seeds the app's localStorage with the session and reloads.
 *
 * Never used for the APK; the credentials are generated per run and never printed.
 */
import { mergeConfig, type Plugin } from 'vite'

import { AuthSession } from './src/bridge/auth'
import { ConnectionStore } from './src/bridge/connection'
import { createFetchTransport } from './src/bridge/http'
import { createMemoryStore, createPlainSecretBox } from './src/bridge/storage'
import { startThrowawayServer } from './test/support/throwaway-server'
import baseConfig from './vite.config'

const PORT = 4176

const gateway = await startThrowawayServer()

const store = new ConnectionStore(createMemoryStore(), createPlainSecretBox())
await new AuthSession(store, createFetchTransport()).login(gateway.baseUrl, {
  password: gateway.password,
  username: gateway.username
})

// The page reaches the gateway through the same-origin proxy below.
const seed = {
  connection: JSON.stringify({ ...(await store.getConnection())!, baseUrl: `http://localhost:${PORT}/gw` }),
  tokens: JSON.stringify(await store.getTokens())
}

const stop = () => void gateway.stop().finally(() => process.exit(0))
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

const harness = (): Plugin => ({
  configurePreviewServer(preview) {
    preview.middlewares.use('/__harness', (_req, res) => {
      res.setHeader('Content-Type', 'text/html')
      res.end(`<!doctype html><script>
        localStorage.setItem('hermes.connection.v1', ${JSON.stringify(seed.connection)});
        localStorage.setItem('hermes.tokens.v1', ${JSON.stringify(seed.tokens)});
        location.replace('/');
      </script>seeding...`)
    })

    preview.httpServer?.once('close', () => void gateway.stop())
    console.log(`harness ready: http://localhost:${PORT}/__harness  (gateway ${gateway.baseUrl})`)
  },
  name: 'hermes-mobile:harness'
})

export default mergeConfig(baseConfig, {
  plugins: [harness()],
  preview: {
    host: 'localhost',
    port: PORT,
    proxy: {
      '/gw': {
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/gw/, ''),
        target: gateway.baseUrl,
        ws: true
      }
    },
    strictPort: true
  }
})
