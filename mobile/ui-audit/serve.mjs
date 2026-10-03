/**
 * Keeps the audit fixtures up for manual poking: mock model + seeded throwaway gateway + harness.
 *   node ui-audit/serve.mjs [--build]   then open http://localhost:4176/__harness
 * Stop with Ctrl+C (the whole process tree, including the throwaway gateway, is killed).
 */
import { build, ensureSchema, seed, startHarness, startMock } from './lib/services.mjs'

if (process.argv.includes('--build')) build()
const mock = await startMock()
await ensureSchema()
seed(mock.url)
const harness = await startHarness()
console.log('ready: http://localhost:4176/__harness  (Ctrl+C to stop)')
const stop = async () => {
  harness.stop()
  await mock.close()
  process.exit(0)
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
await new Promise(() => undefined)
