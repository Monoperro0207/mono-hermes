/**
 * Device regression check: a LIVE multi-step tool run in the real Android WebView.
 *
 *   node ui-audit/device-live-activity.mjs [label] [WxH] [density]
 *     defaults: label "tablet", 2800x1752 @ 440 dpi (~1018 CSS px landscape, Galaxy Tab S8 Ultra class)
 *
 * Needs `node ui-audit/device-server.mjs` running and the debug APK installed on an emulator/device.
 * Signs in with the throwaway credentials from mobile/.env.test (never printed), sends `@@ticker`
 * (mock-llm: six sequential slow tool rounds) and, while the turn is streaming, inspects the live
 * tool-run ticker (`[data-tool-ticker]`): every ticker row must contain its tool row without
 * clipping it (row box == line box, tool row not taller than the line). Saves screenshots to
 * mobile/ui-audit/device/live-activity-<label>-*.png and a JSON dump of the measurements.
 * On an emulator the app data is cleared first. Always resets `wm size` / `wm density`. Exit code 1 when a live ticker row is squashed.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, 'device')
fs.mkdirSync(out, { recursive: true })

const label = process.argv[2] ?? 'tablet'
const SIZE = process.argv[3] ?? '2800x1752'
const DENSITY = process.argv[4] ?? '440'
const PKG = 'com.hermesmovil.app'
const adb = (...args) => execFileSync('adb', args, { maxBuffer: 64 * 1024 * 1024 })
const sleep = ms => new Promise(r => setTimeout(r, ms))

const env = Object.fromEntries(
  fs
    .readFileSync(path.join(here, '..', '.env.test'), 'utf8')
    .split(/\r?\n/)
    .filter(l => l.includes('='))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
)

const shot = name => {
  fs.writeFileSync(path.join(out, `live-activity-${label}-${name}.png`), adb('exec-out', 'screencap', '-p'))
  console.log('saved', `live-activity-${label}-${name}.png`)
}

const connect = async () => {
  let pid = ''
  for (let i = 0; i < 30 && !pid; i++) {
    try {
      pid = adb('shell', 'pidof', PKG).toString().trim().split(/\s+/)[0]
    } catch {
      await sleep(1000)
    }
  }
  adb('forward', 'tcp:9222', `localabstract:webview_devtools_remote_${pid}`)
  let target
  for (let i = 0; i < 30 && !target; i++) {
    try {
      target = (await (await fetch('http://localhost:9222/json')).json()).find(t => t.type === 'page')
    } catch {}
    if (!target) await sleep(1000)
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
  return { evaluate, send, close: () => ws.close() }
}

/** Geometry + computed styles of every live ticker and its rows. */
function measureTickers() {
  const px = el => {
    const r = el.getBoundingClientRect()
    return { top: Math.round(r.top), h: Math.round(r.height * 10) / 10, w: Math.round(r.width) }
  }
  const style = (el, keys) => {
    const cs = getComputedStyle(el)
    return Object.fromEntries(keys.map(k => [k, cs[k]]))
  }
  return Array.from(document.querySelectorAll('[data-tool-ticker]')).map(ticker => {
    const group = ticker.closest('[data-tool-group]')
    const rows = Array.from(ticker.querySelectorAll('.tool-ticker__row')).map(row => {
      const block = row.querySelector('[data-tool-row]')
      const header = block?.firstElementChild?.firstElementChild
      const buttons = Array.from(block?.querySelectorAll('button') ?? []).map(b => ({ label: b.getAttribute('aria-label') || b.textContent.trim().slice(0, 30), ...px(b), ...style(b, ['minHeight', 'height']) }))
      return {
        row: { ...px(row), ...style(row, ['height', 'overflow', 'alignItems']) },
        block: block ? { ...px(block), scrollH: block.scrollHeight, ...style(block, ['minHeight', 'height', 'flexShrink', 'overflow', 'opacity', 'transform']) } : null,
        header: header ? { ...px(header), ...style(header, ['minHeight', 'height']) } : null,
        text: (block?.textContent || '').trim().slice(0, 80),
        buttons
      }
    })
    return {
      ticker: { ...px(ticker), ...style(ticker, ['height', 'overflow']) },
      reel: style(ticker.firstElementChild, ['transform', 'transition']),
      group: group ? { ...px(group), inlineStyle: group.getAttribute('style'), ...style(group, ['height', 'overflow']) } : null,
      lineHeight: getComputedStyle(ticker).getPropertyValue('--conversation-line-height'),
      animations: document.getAnimations().map(a => ({ type: a.constructor.name, name: a.animationName || a.transitionProperty || '', target: a.effect?.target?.className?.toString().slice(0, 60) })).slice(0, 20),
      rows
    }
  })
}

/** A row is squashed when its tool row is taller than the ticker's line box (so it gets clipped/centered over it). */
const squashed = tickers => tickers.flatMap(t => t.rows.filter(r => r.block && (r.block.h > t.ticker.h + 1 || r.block.scrollH > r.row.h + 1)).map(r => ({ text: r.text, block: r.block.h, line: t.ticker.h })))

const page = { close() {} }
let failed = false
try {
  adb('shell', 'wm', 'size', SIZE)
  adb('shell', 'wm', 'density', DENSITY)
  adb('shell', 'am', 'force-stop', PKG)
  // On an emulator only: start from clean app data so the run always opens a fresh session against
  // the current throwaway gateway (never wipes a real device's sign-in).
  if (adb('shell', 'getprop', 'ro.kernel.qemu').toString().trim() === '1') adb('shell', 'pm', 'clear', PKG)
  adb('shell', 'monkey', '-p', PKG, '1')
  await sleep(4000)
  const cdp = await connect()
  Object.assign(page, cdp)

  for (let i = 0; i < 30; i++) {
    const state = await cdp.evaluate(() => (document.querySelector('.hm-connect form') ? 'connect' : document.querySelector('[data-slot=composer-root]') ? 'app' : 'wait'))
    if (state === 'app') break
    if (state === 'connect') {
      await cdp.evaluate(
        (url, user, pass) => {
          const form = document.querySelector('.hm-connect form')
          const set = (name, value) => {
            const input = form.querySelector(`input[name=${name}]`)
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
            input.dispatchEvent(new Event('input', { bubbles: true }))
          }
          set('server', url)
          set('username', user)
          set('password', pass)
          form.requestSubmit()
        },
        env.HERMES_TEST_URL.replace('127.0.0.1', '10.0.2.2'),
        env.HERMES_TEST_USERNAME,
        env.HERMES_TEST_PASSWORD
      )
      await sleep(5000)
    } else await sleep(1000)
  }

  // Optional: inject a stylesheet live (LIVE_CSS=<file>) to confirm a CSS fix before rebuilding the APK.
  if (process.env.LIVE_CSS) {
    await cdp.evaluate(css => {
      const st = document.createElement('style')
      st.textContent = css
      document.head.append(st)
    }, fs.readFileSync(process.env.LIVE_CSS, 'utf8'))
  }
  // Dismiss the soft keyboard the send tap summons, so the thread stays on screen.
  const hideKeyboard = () => {
    try {
      if (/mInputShown=true/.test(adb('shell', 'dumpsys', 'input_method').toString())) adb('shell', 'input', 'keyevent', '4')
    } catch {}
  }
  const viewport = await cdp.evaluate(() => `${innerWidth}x${innerHeight}@${devicePixelRatio}`)
  console.log(label, 'viewport', viewport)
  // Always start from a fresh session (a previous run's session may still be open/running).
  await cdp.evaluate(() => (location.hash = '#/'))
  await sleep(1500)
  const newSession = await cdp.evaluate(() => {
    const el = Array.from(document.querySelectorAll('button, a, [role=button]')).find(e => e.offsetParent && /^New session/i.test((e.textContent || '').trim()))
    const r = el?.getBoundingClientRect()
    return r && { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  if (newSession) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [newSession] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }
  await sleep(2500)

  // Type + send the prompt.
  await cdp.evaluate(() => {
    const e = document.querySelector('[data-slot=composer-root] [contenteditable=true]')
    e.focus()
  })
  await cdp.send('Input.insertText', { text: '@@ticker live activity check' })
  await sleep(500)
  await cdp.evaluate(() => document.querySelector('[data-slot=composer-root] button[aria-label=Send]').click())
  await cdp.evaluate(() => document.activeElement?.blur())
  await sleep(300)
  hideKeyboard()

  const samples = []
  let shots = 0
  for (let t = 0; t < 45; t++) {
    await sleep(1000)
    const tickers = await cdp.evaluate(measureTickers)
    if (tickers.length) {
      samples.push({ t, tickers })
      const bad = squashed(tickers)
      if (bad.length) failed = true
      if (shots < 3 && t % 4 === 0) shot(`live-${++shots}`)
    }
    const running = await cdp.evaluate(() => !!document.querySelector('[data-tool-ticker]') || /Stop|Cancel/i.test(Array.from(document.querySelectorAll('[data-slot=composer-root] button')).map(b => b.getAttribute('aria-label') || '').join(' ')))
    if (!running && t > 10) break
  }
  await sleep(2500)
  shot('settled')
  fs.writeFileSync(path.join(out, `live-activity-${label}.json`), JSON.stringify({ viewport, samples }, null, 2))
  const all = samples.flatMap(s => squashed(s.tickers))
  console.log(label, `samples with a live ticker: ${samples.length}; squashed rows: ${all.length}`, all.slice(0, 3))
  if (!samples.length) {
    console.log('no live ticker observed - scenario did not reproduce')
    failed = true
  }
} finally {
  page.close()
  adb('shell', 'wm', 'size', 'reset')
  adb('shell', 'wm', 'density', 'reset')
}
process.exit(failed ? 1 : 0)
