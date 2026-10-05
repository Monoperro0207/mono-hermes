/**
 * Seeded throwaway gateway for the Android emulator (or a phone on the same network).
 *
 *   node ui-audit/device-server.mjs [publicHost]     # default 10.0.2.2 (the emulator's view of the host loopback)
 *
 * Starts the mock model, seeds the throwaway Hermes home (same fixtures as the audit), starts an
 * isolated gated `hermes serve` on 127.0.0.1 accepting Host 10.0.2.2 and writes its random
 * credentials to the git-ignored mobile/.env.test. Never touches the real Hermes home or the
 * gateway on :9119. Stop with Ctrl+C.
 *
 * It also writes two media files for device-smoke.mjs into a fresh temp directory (removed on exit)
 * and appends their absolute paths to mobile/.env.test:
 *   HERMES_TEST_MEDIA_SMALL  ~1 s of 8 kHz mono 16-bit PCM silence (a valid WAV)
 *   HERMES_TEST_MEDIA_BIG    65 MiB = the phone's 64 MiB media cap + 1 MiB
 * Both are .wav: /api/files/stream only serves an extension allowlist (it answers 415 for e.g. .bin),
 * and the gateway's own 100 MiB cap is above 65 MiB, so the refusal of the big file has to come from
 * the phone's native cap and not from the gateway. The managed-files root is unlocked on this
 * throwaway server (any absolute path is served), so the temp directory needs no special location.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { startThrowawayServer } from '../test/support/throwaway-server.ts'

import { ensureSchema, MOBILE, seed, startMock } from './lib/services.mjs'

const publicHost = process.argv[2] ?? '10.0.2.2'
const mock = await startMock()
await ensureSchema()
seed(mock.url)

const envFile = path.join(MOBILE, '.env.test')
const server = await startThrowawayServer({ envFile, publicHost })

const MIB = 1024 * 1024
// A previous run killed without a signal (e.g. taskkill /F) leaves its 65 MiB behind: sweep day-old ones.
for (const name of fs.readdirSync(os.tmpdir())) {
  const stale = path.join(os.tmpdir(), name)
  if (name.startsWith('hermes-smoke-') && Date.now() - fs.statSync(stale).mtimeMs > 24 * 3600_000) fs.rmSync(stale, { force: true, recursive: true })
}
const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-smoke-'))
const smallMedia = path.join(mediaDir, 'smoke-small.wav')
const bigMedia = path.join(mediaDir, 'smoke-big.wav')

/** One second of silence: 8 kHz, mono, 16-bit PCM. */
function silentWav(seconds = 1, rate = 8000) {
  const data = Buffer.alloc(rate * 2 * seconds)
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVEfmt ', 8)
  head.writeUInt32LE(16, 16) // fmt chunk size
  head.writeUInt16LE(1, 20) // PCM
  head.writeUInt16LE(1, 22) // mono
  head.writeUInt32LE(rate, 24)
  head.writeUInt32LE(rate * 2, 28) // byte rate
  head.writeUInt16LE(2, 32) // block align
  head.writeUInt16LE(16, 34) // bits per sample
  head.write('data', 36)
  head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

fs.writeFileSync(smallMedia, silentWav())
{
  // 65 MiB in 1 MiB chunks, never one giant buffer.
  const chunk = Buffer.alloc(MIB)
  const fd = fs.openSync(bigMedia, 'w')
  try {
    for (let i = 0; i < 65; i++) fs.writeSync(fd, chunk)
  } finally {
    fs.closeSync(fd)
  }
}
fs.appendFileSync(envFile, [`HERMES_TEST_MEDIA_SMALL=${smallMedia}`, `HERMES_TEST_MEDIA_BIG=${bigMedia}`, ''].join('\n'))

const stop = async () => {
  await server.stop()
  await mock.close()
  fs.rmSync(mediaDir, { force: true, recursive: true })
  process.exit(0)
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

console.log(`device gateway ready on ${server.baseUrl} (Host ${publicHost}); credentials in mobile/.env.test`)
await new Promise(() => undefined)
