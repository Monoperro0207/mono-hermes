/**
 * Keeps a throwaway gated `hermes serve` running so an Android emulator (or a phone on the
 * same network) can sign in against it. Run with plain Node (type stripping):
 *
 *   node test/support/serve-for-device.ts [publicHost]      # default publicHost 10.0.2.2
 *
 * 10.0.2.2 is how the emulator sees the host's loopback. Credentials go to the git-ignored
 * mobile/.env.test; stop with Ctrl+C (the server and its process tree are killed).
 */
import path from 'node:path'

import { startThrowawayServer } from './throwaway-server.ts'

const publicHost = process.argv[2] ?? '10.0.2.2'

const server = await startThrowawayServer({
  envFile: path.resolve(import.meta.dirname, '../../.env.test'),
  publicHost
})

const stop = () => void server.stop().finally(() => process.exit(0))
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

console.log(`throwaway server ready on ${server.baseUrl} (accepting Host ${publicHost}); credentials in mobile/.env.test`)

await new Promise(() => undefined)
