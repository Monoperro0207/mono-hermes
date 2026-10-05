/**
 * Shared plumbing for the on-device checks (device-rotation.mjs, device-smoke.mjs): adb, a minimal
 * CDP client for the Android WebView page, the throwaway credentials and the sign-in loop.
 *
 * The CDP client relies on a debuggable WebView: the debug APK is built with
 * HERMES_MOBILE_WEBVIEW_DEBUG=1 (capacitor.config.ts -> webContentsDebuggingEnabled), which makes the
 * WebView publish the `webview_devtools_remote_<pid>` abstract socket that is forwarded below.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
/** mobile/ */
export const MOBILE = path.resolve(here, '../..')

export const PKG = 'com.hermesmovil.app'
export const CDP_PORT = 9222

export const adb = (...args) => execFileSync('adb', args, { maxBuffer: 64 * 1024 * 1024 })
export const sleep = ms => new Promise(r => setTimeout(r, ms))

/** KEY=VALUE pairs of the git-ignored mobile/.env.test written by device-server.mjs. */
export const loadEnv = () =>
  Object.fromEntries(
    fs
      .readFileSync(path.join(MOBILE, '.env.test'), 'utf8')
      .split(/\r?\n/)
      .filter(l => l.includes('='))
      .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
  )

/** True on an emulator (never on a real phone, where `pm clear` would wipe the user's app data). */
export const isEmulator = () => adb('shell', 'getprop', 'ro.kernel.qemu').toString().trim() === '1'

/**
 * Starts the app from scratch: force-stop, clean data on an emulator only, launch, give it time to
 * bring the WebView up.
 */
export async function launchApp() {
  adb('shell', 'am', 'force-stop', PKG)
  if (isEmulator()) adb('shell', 'pm', 'clear', PKG)
  adb('shell', 'monkey', '-p', PKG, '1')
  await sleep(4000)
}

/** The app process id, or '' when it is not running. */
export const appPid = () => {
  try {
    return adb('shell', 'pidof', PKG).toString().trim().split(/\s+/)[0]
  } catch {
    return ''
  }
}

/** Minimal CDP client for the WebView page target (Android WebView exposes no browser target). */
export const connect = async () => {
  let pid = ''
  for (let i = 0; i < 30 && !pid; i++) {
    pid = appPid()
    if (!pid) await sleep(1000)
  }
  adb('forward', `tcp:${CDP_PORT}`, `localabstract:webview_devtools_remote_${pid}`)
  let target
  for (let i = 0; i < 30 && !target; i++) {
    try {
      target = (await (await fetch(`http://localhost:${CDP_PORT}/json`)).json()).find(t => t.type === 'page')
    } catch {}
    if (!target) await sleep(1000)
  }
  if (!target) {
    removeForward()
    throw new Error('no WebView page target found: is the app a debug build (HERMES_MOBILE_WEBVIEW_DEBUG=1)?')
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  let id = 0
  const pending = new Map()
  ws.onmessage = event => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
  const send = (method, params = {}) =>
    new Promise(resolve => {
      const n = ++id
      pending.set(n, resolve)
      ws.send(JSON.stringify({ id: n, method, params }))
    })
  const evaluate = async (fn, ...args) => {
    const expression = `(${fn.toString()})(...${JSON.stringify(args)})`
    const res = await send('Runtime.evaluate', { awaitPromise: true, expression, returnByValue: true })
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.text + ' ' + (res.result.exceptionDetails.exception?.description ?? ''))
    return res.result?.result?.value
  }
  const tapAt = async pt => {
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] })
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }
  /** Real touch tap on the first visible element matching `selector` (and aria-label, if given). */
  const tap = async (selector, ariaLabel) => {
    const pt = await evaluate(
      (sel, aria) => {
        const el = Array.from(document.querySelectorAll(sel)).find(e => e.offsetParent !== null && (!aria || e.getAttribute('aria-label') === aria))
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      },
      selector,
      ariaLabel ?? null
    )
    if (!pt) return false
    await tapAt(pt)
    await sleep(900)
    return true
  }
  /** Closes the socket and drops the adb port forward. */
  const close = () => {
    try {
      ws.close()
    } catch {}
    removeForward()
  }
  return { evaluate, send, tap, close }
}

function removeForward() {
  try {
    adb('forward', '--remove', `tcp:${CDP_PORT}`)
  } catch {}
}

/**
 * Signs in with the throwaway credentials until the app shell is up (`[data-slot=composer-root]`).
 * 10.0.2.2 is a LAN address: plain http:// to it needs the explicit consent checkbox, which only
 * exists after the first submit was answered with the warning (the second pass ticks it).
 * Returns true when the shell appeared.
 */
export async function signIn(cdp, env, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    const s = await cdp.evaluate(() => (document.querySelector('.hm-connect form') ? 'connect' : document.querySelector('[data-slot=composer-root]') ? 'app' : 'wait'))
    if (s === 'app') return true
    if (s === 'connect') {
      await cdp.evaluate(
        (url, user, pass) => {
          const form = document.querySelector('.hm-connect form')
          const set = (n, v) => {
            const input = form.querySelector(`input[name=${n}]`)
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, v)
            input.dispatchEvent(new Event('input', { bubbles: true }))
          }
          set('server', url)
          set('username', user)
          set('password', pass)
          const consent = form.querySelector('input[name=lan-consent]')
          if (consent && !consent.checked) consent.click()
          form.requestSubmit()
        },
        env.HERMES_TEST_URL.replace('127.0.0.1', '10.0.2.2'),
        env.HERMES_TEST_USERNAME,
        env.HERMES_TEST_PASSWORD
      )
      await sleep(5000)
    } else await sleep(1000)
  }
  return false
}
