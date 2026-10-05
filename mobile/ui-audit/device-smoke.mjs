/**
 * Fast functional smoke of the real Android WebView + native stack (emulator or phone).
 *
 *   node ui-audit/device-smoke.mjs
 *     SMOKE_REQUIRE_PUBLIC=1  make the checks that need the public internet (example.com, DNS) fatal
 *                             instead of a WARN
 *
 * Needs `node ui-audit/device-server.mjs` running (it writes the throwaway credentials and the two
 * media files into mobile/.env.test) and the DEBUG APK installed (WebView remote debugging on, see
 * lib/device.mjs). Starts the app from clean data (emulator only), signs in through the LAN-consent
 * flow, waits for the app shell and then asserts through CDP:
 *   a  the native BoundedHttp plugin is registered and the app runs natively
 *   b  a small hermes-media:// file is downloaded natively and plays from a blob: URL
 *   c  a file over the 64 MiB cap is refused while streaming (error, never a blob:), and the page and
 *      the app process survive
 *   d  link title to a private host returns ''
 *   e  link title to a public page returns its title                          (network dependent)
 *   f  the native DNS guard: a public name that resolves to loopback and a private IP literal are
 *      both rejected with `blocked_host`                                        (the name needs DNS)
 * Every check prints `ok` / `FAIL <reason>` / `WARN <reason>`; a failing check saves
 * ui-audit/device/smoke-<name>.png. Exit code 1 when any check fails.
 * It changes nothing global (no rotation, no wm size) and always closes the CDP socket and removes
 * the adb port forward.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { adb, appPid, connect, launchApp, loadEnv, signIn, sleep } from './lib/device.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, 'device')
fs.mkdirSync(out, { recursive: true })

const REQUIRE_PUBLIC = process.env.SMOKE_REQUIRE_PUBLIC === '1'
const env = loadEnv()

let total = 0
let failing = 0

const shot = name => {
  try {
    fs.writeFileSync(path.join(out, `smoke-${name}.png`), adb('exec-out', 'screencap', '-p'))
  } catch (error) {
    console.log(`  (no screenshot: ${error.message})`)
  }
}
const ok = (name, detail = '') => {
  total++
  console.log(`ok ${name}${detail ? ` (${detail})` : ''}`)
}
const fail = (name, reason) => {
  total++
  failing++
  console.log(`FAIL ${name}: ${reason}`)
  shot(name)
}
const warn = (name, reason) => {
  total++
  console.log(`WARN ${name}: ${reason}`)
}
/** Fatal when the public internet is required, a WARN otherwise. */
const publicDependent = (name, reason) => (REQUIRE_PUBLIC ? fail(name, reason) : warn(name, `${reason} (network dependent; set SMOKE_REQUIRE_PUBLIC=1 to make this fatal)`))

/** PSS / RSS in KiB of the app, from `dumpsys meminfo`; null when it cannot be read. */
function meminfo() {
  try {
    const text = adb('shell', 'dumpsys', 'meminfo', 'com.hermesmovil.app').toString()
    const pss = /TOTAL PSS:\s+(\d+)/.exec(text) ?? /^\s*TOTAL\s+(\d+)/m.exec(text)
    const rss = /TOTAL RSS:\s+(\d+)/.exec(text)
    return pss ? { pss: Number(pss[1]), rss: rss ? Number(rss[1]) : null } : null
  } catch {
    return null
  }
}
const fmtMem = m => (m ? `PSS ${(m.pss / 1024).toFixed(0)} MiB${m.rss ? `, RSS ${(m.rss / 1024).toFixed(0)} MiB` : ''}` : 'n/a')

/** hermes-media:// URL of an absolute gateway path (same form as upstream's mediaGatewayStreamUrl). */
const mediaUrl = absolutePath => `hermes-media://remote/${encodeURIComponent(absolutePath)}`

/**
 * Runs in the page. Creates a detached-in-DOM <audio>, sets its src to a hermes-media:// URL and
 * reports what it saw. mode 'metadata': stop when the element has a blob: src and its metadata
 * loaded; mode 'error': stop shortly after the media shim reports a failed load. Also records the
 * console.warn lines the shim emits.
 *
 * The element itself fires an early `error` (MEDIA_ERR_SRC_NOT_SUPPORTED) because the shim first shows
 * the hermes-media:// URL while it downloads, so a bare `error` event proves nothing: the shim's own
 * failure is the "media load failed" warning plus the synthetic `error` event dispatched right after it
 * (`errorAfterFailure`).
 */
function probeMedia(url, mode, timeoutMs) {
  return new Promise(resolve => {
    const warns = []
    const nativeWarn = console.warn
    console.warn = (...args) => {
      const line = args.map(a => String(a?.message ?? a)).join(' ')
      warns.push(line)
      if (/media load failed/.test(line)) {
        failed = true
        if (mode === 'error') setTimeout(finish, 1500) // grace period: make sure no blob: shows up after the failure
      }
      nativeWarn.apply(console, args)
    }
    const audio = document.createElement('audio')
    audio.muted = true
    audio.preload = 'auto'
    const state = { sawBlob: false, metadata: false, error: false, errorAfterFailure: false, duration: null, src: '', warns, timedOut: false }
    let failed = false
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      clearInterval(poll)
      clearTimeout(timer)
      state.sawBlob ||= audio.src.startsWith('blob:')
      state.src = audio.src.slice(0, 40)
      state.duration = Number.isFinite(audio.duration) ? audio.duration : null
      console.warn = nativeWarn
      audio.remove()
      resolve(state)
    }
    const poll = setInterval(() => {
      if (audio.src.startsWith('blob:')) state.sawBlob = true
      if (mode === 'metadata' && state.sawBlob && state.metadata) finish()
    }, 50)
    const timer = setTimeout(() => {
      state.timedOut = true
      finish()
    }, timeoutMs)
    audio.addEventListener('loadedmetadata', () => {
      state.metadata = true
      state.duration = audio.duration
    })
    audio.addEventListener('error', () => {
      state.error = true
      if (failed) state.errorAfterFailure = true
    })
    document.body.appendChild(audio)
    audio.src = url
  })
}

/** Runs in the page: awaits a promise-returning plugin call and returns either its value or the rejection code. */
async function callPlugin(method, options) {
  try {
    const value = await window.Capacitor.Plugins.BoundedHttp[method](options)
    return { resolved: true, status: value?.status ?? null }
  } catch (error) {
    return { resolved: false, code: error?.code ?? null, message: String(error?.message ?? error) }
  }
}

const gatewayPort = new URL(env.HERMES_TEST_URL).port

let cdp = null
try {
  for (const key of ['HERMES_TEST_MEDIA_SMALL', 'HERMES_TEST_MEDIA_BIG']) {
    if (!env[key]) throw new Error(`${key} missing from mobile/.env.test: run \`node ui-audit/device-server.mjs\` first`)
  }

  await launchApp()
  cdp = await connect()
  if (!(await signIn(cdp, env))) {
    fail('app-shell', 'the app shell ([data-slot=composer-root]) never appeared after signing in')
    throw new Error('cannot continue without the app shell')
  }
  await sleep(2500)
  ok('app-shell')

  // a. native plugin present
  const plugin = await cdp.evaluate(() => ({ plugin: !!window.Capacitor?.Plugins?.BoundedHttp, native: !!window.Capacitor?.isNativePlatform?.() }))
  if (plugin.plugin && plugin.native) ok('plugin-registered')
  else fail('plugin-registered', `Capacitor.Plugins.BoundedHttp=${plugin.plugin}, isNativePlatform=${plugin.native}`)

  // b. small media: native download -> blob: URL -> plays
  const small = await cdp.evaluate(probeMedia, mediaUrl(env.HERMES_TEST_MEDIA_SMALL), 'metadata', 30_000)
  if (small.sawBlob && small.metadata && small.duration > 0.8 && small.duration < 1.3) ok('media-small', `duration ${small.duration.toFixed(2)} s`)
  else fail('media-small', `blob=${small.sawBlob} metadata=${small.metadata} duration=${small.duration} error=${small.error} errorAfterFailure=${small.errorAfterFailure} timedOut=${small.timedOut} src=${small.src} warns=${JSON.stringify(small.warns)}`)

  // c. media above the 64 MiB cap: refused while streaming, nothing breaks
  const pidBefore = appPid()
  const memBefore = meminfo()
  let memPeak = memBefore
  const bigProbe = cdp.evaluate(probeMedia, mediaUrl(env.HERMES_TEST_MEDIA_BIG), 'error', 60_000)
  let probing = true
  bigProbe.then(
    () => (probing = false),
    () => (probing = false)
  )
  while (probing) {
    await Promise.race([bigProbe.catch(() => undefined), sleep(1500)])
    const m = meminfo()
    if (m && (!memPeak || m.pss > memPeak.pss)) memPeak = m
  }
  const big = await bigProbe
  await sleep(2000)
  const memAfter = meminfo()
  console.log(`info memory around the big file: before ${fmtMem(memBefore)}; peak ${fmtMem(memPeak)}; after ${fmtMem(memAfter)}`)
  const tooLarge = big.warns.some(w => /too large/i.test(w))
  if (big.errorAfterFailure && !big.sawBlob && tooLarge) ok('media-big-refused')
  else fail('media-big-refused', `error=${big.error} errorAfterFailure=${big.errorAfterFailure} blob=${big.sawBlob} tooLargeWarning=${tooLarge} timedOut=${big.timedOut} src=${big.src} warns=${JSON.stringify(big.warns)}`)
  let alive = null
  try {
    alive = await cdp.evaluate(() => 1 + 1)
  } catch (error) {
    alive = error.message
  }
  if (alive === 2) ok('page-alive-after-big')
  else fail('page-alive-after-big', `evaluate returned ${alive}`)
  const pidAfter = appPid()
  if (pidBefore && pidAfter === pidBefore) ok('process-alive-after-big', `pid ${pidAfter}`)
  else fail('process-alive-after-big', `pid before ${pidBefore || '(none)'}, after ${pidAfter || '(none)'}`)

  // d. link title to a private host
  const privateTitle = await cdp.evaluate(url => window.hermesDesktop.fetchLinkTitle(url), `http://10.0.2.2:${gatewayPort}/`)
  if (privateTitle === '') ok('link-title-private')
  else fail('link-title-private', `expected '', got ${JSON.stringify(privateTitle)}`)

  // e. link title to a public page (needs the internet)
  const publicTitle = await cdp.evaluate(url => window.hermesDesktop.fetchLinkTitle(url), 'https://example.com/')
  if (/example/i.test(publicTitle ?? '')) ok('link-title-public', JSON.stringify(publicTitle))
  else publicDependent('link-title-public', `expected a title containing "Example", got ${JSON.stringify(publicTitle)}`)

  // f. the native guard itself, bypassing the renderer's own URL gate
  const rebinding = await cdp.evaluate(callPlugin, 'fetchPublicText', { url: 'http://127.0.0.1.nip.io/', maxBytes: 1024 })
  if (!rebinding.resolved && rebinding.code === 'blocked_host') ok('dns-guard-rebinding-name', rebinding.message)
  else if (!rebinding.resolved && rebinding.code === 'network') publicDependent('dns-guard-rebinding-name', `DNS looks unavailable (code network: ${rebinding.message})`)
  else fail('dns-guard-rebinding-name', `expected rejection blocked_host, got ${JSON.stringify(rebinding)}`)

  const literal = await cdp.evaluate(callPlugin, 'fetchPublicText', { url: 'http://10.0.2.2/', maxBytes: 1024 })
  if (!literal.resolved && literal.code === 'blocked_host') ok('dns-guard-private-literal')
  else fail('dns-guard-private-literal', `expected rejection blocked_host, got ${JSON.stringify(literal)}`)
} catch (error) {
  console.log(`FAIL smoke-aborted: ${error?.stack ?? error}`)
  total++
  failing++
} finally {
  cdp?.close()
}

console.log(`smoke: ${total} checks, ${failing} failing`)
process.exit(failing ? 1 : 0)
