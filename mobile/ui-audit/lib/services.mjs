/**
 * Process orchestration for the UI audit: build, mock model, seed, harness (throwaway gateway + preview).
 * Everything lives under the git-ignored repo-root .cache/ - never the user's real Hermes home.
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { startMockLlm } from '../mock-llm.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const MOBILE = path.resolve(here, '../..')
export const REPO = path.resolve(MOBILE, '..')
export const HOME = process.env.HERMES_TEST_HOME || path.join(REPO, '.cache', 'hm')
export const HARNESS_PORT = 4176
export const MOCK_PORT = 47831

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'

export function killTree(child) {
  if (!child || child.killed || !child.pid) return
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else child.kill('SIGTERM')
  } catch {
    /* already gone */
  }
}

export function portBusy(port) {
  return new Promise(resolve => {
    const s = net.createConnection({ port, host: '127.0.0.1' })
    s.once('connect', () => (s.destroy(), resolve(true)))
    s.once('error', () => resolve(false))
  })
}

export function build() {
  console.log('[audit] vite build ...')
  const r = spawnSync(npx, ['vite', 'build'], { cwd: MOBILE, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', encoding: 'utf8' })
  if (r.status !== 0) {
    console.error(r.stdout?.slice(-2000), r.stderr?.slice(-2000))
    throw new Error('vite build failed')
  }
}

function pythonCommand() {
  for (const cmd of [process.env.PYTHON, 'python', 'py'].filter(Boolean)) {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' })
    if (r.status === 0) return cmd
  }
  throw new Error('python (stdlib only) is required to seed the throwaway Hermes home')
}

/**
 * The throwaway server creates state.db's schema on first start. Do that once, then keep a
 * schema-only copy (state.db.template) that seed.py restores on every run - the live database of a
 * previous run (WAL, FTS shadow tables, rows written by real turns) is never reused.
 */
export async function ensureSchema() {
  const template = path.join(HOME, 'state.db.template')
  if (fs.existsSync(template)) return
  console.log('[audit] first run: letting a throwaway gateway create the schema ...')
  for (const s of ['', '-wal', '-shm']) fs.rmSync(path.join(HOME, `state.db${s}`), { force: true })
  const { startThrowawayServer } = await import(pathToUrl(path.join(MOBILE, 'test/support/throwaway-server.ts')))
  const srv = await startThrowawayServer()
  await new Promise(r => setTimeout(r, 4000))
  await srv.stop()
  const py = pythonCommand()
  const code = `import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute("PRAGMA wal_checkpoint(TRUNCATE)");c.execute("DELETE FROM messages");c.execute("DELETE FROM sessions");c.commit();c.execute("VACUUM INTO ?",(sys.argv[2],))`
  const r = spawnSync(py, ['-c', code, path.join(HOME, 'state.db'), template], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error('could not create state.db.template: ' + (r.stderr || r.stdout))
}

const pathToUrl = p => 'file:///' + p.split(path.sep).join('/')

export function seed(mockUrl) {
  const py = pythonCommand()
  const r = spawnSync(py, [path.join(MOBILE, 'ui-audit/seed.py'), mockUrl], { env: { ...process.env, HERMES_HOME: HOME, PYTHONIOENCODING: 'utf-8' }, encoding: 'utf8' })
  if (r.status !== 0) throw new Error('seed failed: ' + (r.stderr || r.stdout))
  console.log('[audit]', r.stdout.trim())
}

export async function startMock() {
  return startMockLlm(MOCK_PORT)
}

/** Start `vite preview --config vite.harness.config.ts` (it boots the throwaway gateway). */
export async function startHarness() {
  if (await portBusy(HARNESS_PORT)) throw new Error(`port ${HARNESS_PORT} is busy: stop the other harness first`)
  const child = spawn(npx, ['vite', 'preview', '--config', 'vite.harness.config.ts'], {
    cwd: MOBILE,
    env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' },
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let out = ''
  const ready = new Promise((resolve, reject) => {
    const onData = d => {
      out += d.toString()
      if (/harness ready:/.test(out)) resolve()
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('exit', code => reject(new Error(`harness exited (${code}):\n${out.slice(-1500)}`)))
    setTimeout(() => reject(new Error('harness did not become ready:\n' + out.slice(-1500))), 25 * 60_000)
  })
  await ready
  const gw = /gateway (http:\/\/[^)\s]+)/.exec(out)?.[1]
  return { child, gateway: gw, stop: () => killTree(child) }
}
