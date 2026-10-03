/**
 * Seeded throwaway gateway for the Android emulator (or a phone on the same network).
 *
 *   node ui-audit/device-server.mjs [publicHost]     # default 10.0.2.2 (the emulator's view of the host loopback)
 *
 * Starts the mock model, seeds the throwaway Hermes home (same fixtures as the audit), starts an
 * isolated gated `hermes serve` on 127.0.0.1 accepting Host 10.0.2.2 and writes its random
 * credentials to the git-ignored mobile/.env.test. Never touches the real Hermes home or the
 * gateway on :9119. Stop with Ctrl+C.
 */
import path from 'node:path'

import { startThrowawayServer } from '../test/support/throwaway-server.ts'

import { ensureSchema, MOBILE, seed, startMock } from './lib/services.mjs'

const publicHost = process.argv[2] ?? '10.0.2.2'
const mock = await startMock()
await ensureSchema()
seed(mock.url)

const server = await startThrowawayServer({ envFile: path.join(MOBILE, '.env.test'), publicHost })

const stop = async () => {
  await server.stop()
  await mock.close()
  process.exit(0)
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

console.log(`device gateway ready on ${server.baseUrl} (Host ${publicHost}); credentials in mobile/.env.test`)
await new Promise(() => undefined)
