/**
 * Starts an ISOLATED `hermes serve` for end-to-end tests and stops it again.
 *
 * Safety: it never touches the user's Hermes home or running gateway.
 *  - HERMES_HOME is a dedicated directory under the git-ignored repo-root .cache/;
 *  - `--isolated` skips attaching to the host's machine-level backend;
 *  - it binds 127.0.0.1 on a free port; gated (login-required) mode is forced with
 *    HERMES_DASHBOARD_PUBLIC_URL pointing at a non-loopback hostname, and the
 *    password provider is configured through HERMES_DASHBOARD_BASIC_AUTH_* env vars;
 *  - credentials are randomly generated per run and only written to the gitignored
 *    mobile/.env.test (never logged).
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

export interface ThrowawayServer {
  baseUrl: string
  username: string
  password: string
  home: string
  stop: () => Promise<void>
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function hermesCommand(): string {
  return process.env.HERMES_BIN || (process.platform === 'win32' ? 'hermes.exe' : 'hermes')
}

/**
 * The first start builds an isolated Python runtime inside HERMES_HOME (~1 GB, several
 * minutes), so the directory persists between runs. It must stay SHORT: Windows'
 * 260-char path limit breaks native wheels (psutil DLL) under deeper paths. It lives
 * in the git-ignored repo-root `.cache/`, never in the user's real Hermes home.
 */
function throwawayHome(): string {
  return process.env.HERMES_TEST_HOME || path.resolve(import.meta.dirname, '../../../.cache/hm')
}

export interface ThrowawayOptions {
  /** Write the generated credentials here (mobile/.env.test). */
  envFile?: string
  /**
   * Extra hostname the server must accept in the Host header, e.g. 10.0.2.2 for an Android
   * emulator (the host's loopback as seen from the guest). Default: a placeholder that only
   * serves to engage the login gate on loopback.
   */
  publicHost?: string
}

export async function startThrowawayServer(options: ThrowawayOptions = {}): Promise<ThrowawayServer> {
  const home = throwawayHome()
  fs.mkdirSync(home, { recursive: true })
  const port = await freePort()
  const username = `tester-${randomBytes(3).toString('hex')}`
  const password = randomBytes(18).toString('base64url')
  const baseUrl = `http://127.0.0.1:${port}`

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HERMES_DASHBOARD_BASIC_AUTH_PASSWORD: password,
    HERMES_DASHBOARD_BASIC_AUTH_SECRET: randomBytes(32).toString('hex'),
    HERMES_DASHBOARD_BASIC_AUTH_USERNAME: username,
    HERMES_DASHBOARD_PUBLIC_URL: `http://${options.publicHost ?? 'hermes-mobile-test.invalid'}`,
    HERMES_HOME: home,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1'
  }

  // Never inherit anything that could point the throwaway at the user's real setup or let it
  // reach a real model provider: drop desktop markers and every credential-looking variable
  // (the only secrets it needs are the HERMES_DASHBOARD_BASIC_AUTH_* values set above).
  const ours = new Set([
    'HERMES_DASHBOARD_BASIC_AUTH_PASSWORD',
    'HERMES_DASHBOARD_BASIC_AUTH_SECRET',
    'HERMES_DASHBOARD_BASIC_AUTH_USERNAME'
  ])

  for (const key of Object.keys(env)) {
    const markers = /^HERMES_(DESKTOP|PARENT_PID|DASHBOARD_SESSION)/.test(key)
    const credentials = /(API_KEY|_TOKEN|_SECRET|PASSWORD|CREDENTIAL)/i.test(key)

    if (!ours.has(key) && (markers || credentials)) {
      delete env[key]
    }
  }

  const logFile = path.join(home, 'serve.log')
  const log = fs.openSync(logFile, 'w')

  const child: ChildProcess = spawn(
    hermesCommand(),
    ['serve', '--isolated', '--host', '127.0.0.1', '--port', String(port), '--skip-build'],
    // Own process group on POSIX so stop() can take the whole tree down (the hermes shim launches Python).
    { detached: process.platform !== 'win32', env, stdio: ['ignore', log, log], windowsHide: true }
  )

  let exited = false
  child.on('exit', () => {
    exited = true
  })

  const stop = async () => {
    if (!exited && child.pid) {
      try {
        if (process.platform === 'win32') {
          // Kills the whole tree (the hermes shim launches a Python child).
          execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        } else {
          try {
            process.kill(-child.pid, 'SIGTERM')
          } catch {
            child.kill('SIGTERM')
          }
        }
      } catch {
        // already gone
      }
    }

    await sleep(300)
  }

  // Generous: a cold start builds the runtime first.
  const deadline = Date.now() + 25 * 60_000

  while (Date.now() < deadline) {
    if (exited) {
      const tail = fs.readFileSync(logFile, 'utf8').split('\n').slice(-25).join('\n')
      await stop()
      throw new Error(`hermes serve exited during startup:\n${tail}`)
    }

    try {
      const response = await fetch(`${baseUrl}/api/health`)

      if (response.ok) {
        break
      }
    } catch {
      // not up yet
    }

    await sleep(500)
  }

  if (Date.now() >= deadline) {
    const tail = fs.readFileSync(logFile, 'utf8').split('\n').slice(-25).join('\n')
    await stop()
    throw new Error(`hermes serve did not become ready:\n${tail}`)
  }

  if (options.envFile) {
    fs.writeFileSync(
      options.envFile,
      `HERMES_TEST_URL=${baseUrl}\nHERMES_TEST_USERNAME=${username}\nHERMES_TEST_PASSWORD=${password}\n`
    )
  }

  return { baseUrl, home, password, stop, username }
}
