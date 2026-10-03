/**
 * Spot-check the REAL Android WebView: drives the installed app through its debuggable WebView
 * (adb forward + CDP) and saves `adb exec-out screencap` images into mobile/ui-audit/device/.
 *
 *   node ui-audit/device-shots.mjs <cover|inner>     # app already signed in on the device/emulator
 *
 * It sets `adb shell wm size/density` to the Galaxy Z Fold4 panel (cover 904x2316, inner 2176x1812
 * at 420 dpi) and ALWAYS resets them afterwards.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'


const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, 'device')
fs.mkdirSync(out, { recursive: true })

const mode = process.argv[2] === 'inner' ? 'inner' : 'cover'
const SIZE = mode === 'inner' ? '2176x1812' : '904x2316'
const adb = (...args) => execFileSync('adb', args, { maxBuffer: 64 * 1024 * 1024 })
const sleep = ms => new Promise(r => setTimeout(r, ms))

const shot = async name => {
  await sleep(900)
  fs.writeFileSync(path.join(out, `${mode}-${name}.png`), adb('exec-out', 'screencap', '-p'))
  console.log('saved', `${mode}-${name}.png`)
}

/** Minimal CDP client for the WebView page target (Playwright's connectOverCDP needs the browser target, which Android WebView does not expose). */
const connect = async () => {
  const pid = adb('shell', 'pidof', 'com.hermesmovil.app').toString().trim().split(/\s+/)[0]
  adb('forward', 'tcp:9222', `localabstract:webview_devtools_remote_${pid}`)
  const targets = await (await fetch('http://localhost:9222/json')).json()
  const target = targets.find(t => t.type === 'page')
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
  const page = {
    evaluate,
    send,
    /** Real touch tap (CDP touch events -> pointerType "touch") on the first visible element whose aria-label / own text matches. */
    click: async (matcher, scope = 'document') => {
      const pt = await evaluate(
        (m, sc) => {
          const root = sc === 'document' ? document : document.querySelector(sc)
          const els = Array.from((root || document).querySelectorAll('button, [role=button], [role=menuitem], [role=menuitemradio], a, [data-slot=pane-tab], span, div'))
          const re = new RegExp(m, 'i')
          const el = els.find(e => e.offsetParent !== null && (re.test(e.getAttribute('aria-label') || '') || (e.children.length === 0 && re.test((e.textContent || '').trim()))))
          if (!el) return null
          el.scrollIntoView({ block: 'center' })
          const r = el.getBoundingClientRect()
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
        },
        matcher,
        scope
      )
      if (!pt) return false
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] })
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await sleep(300)
      return true
    },
    tapSelector: async selector => {
      const pt = await evaluate(sel => {
        const el = document.querySelector(sel)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      }, selector)
      if (!pt) return false
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] })
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await sleep(300)
      return true
    },
    key: async (key, code, vk) => {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
    },
    type: text => send('Input.insertText', { text }),
    close: () => ws.close()
  }
  return { page }
}

try {
  adb('shell', 'wm', 'size', SIZE)
  adb('shell', 'wm', 'density', '420')
  await sleep(1500)
  const { page } = await connect()
  for (let i = 0; i < 30 && !(await page.evaluate(() => !!document.querySelector('[data-slot=composer-root]'))); i++) await sleep(1000)
  const info = await page.evaluate(() => ({
    css: `${innerWidth}x${innerHeight}`,
    dpr: devicePixelRatio,
    safeTop: getComputedStyle(document.documentElement).getPropertyValue('--safe-area-inset-top'),
    safeBottom: getComputedStyle(document.documentElement).getPropertyValue('--safe-area-inset-bottom'),
    scrollW: document.documentElement.scrollWidth,
    pointerCoarse: matchMedia('(pointer: coarse)').matches,
    hoverNone: matchMedia('(hover: none)').matches
  }))
  console.log(mode, JSON.stringify(info))
  fs.writeFileSync(path.join(out, `${mode}-viewport.json`), JSON.stringify(info, null, 2))

  const go = async hash => {
    await page.evaluate(h => (location.hash = h), hash)
    await sleep(2500)
  }
  const blur = async () => {
    await page.evaluate(() => document.activeElement && document.activeElement.blur())
    await sleep(500)
  }
  const dismissToasts = () => page.evaluate(() => Array.from(document.querySelectorAll('button[aria-label="Dismiss notification"]')).forEach(b => b.click()))
  const scrollThread = frac =>
    page.evaluate(f => {
      const sc = Array.from(document.querySelectorAll('*')).filter(e => e.scrollHeight > e.clientHeight + 40 && /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.clientHeight > 200).sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
      if (sc) sc.scrollTop = sc.scrollHeight * f
    }, frac)

  await blur()
  await dismissToasts()
  await go('#/')
  await shot('01-home')

  await page.click('^Show sidebar$')
  await sleep(900)
  await shot('02-sidebar')
  await page.click('^Hide sidebar$')
  await sleep(600)

  await go('#/aud-md')
  await blur()
  await shot('03-markdown-top')
  await scrollThread(0.45)
  await shot('04-markdown-table')

  await go('#/aud-tools')
  await blur()
  for (let round = 0; round < 2; round++) {
    await page.evaluate(() => Array.from(document.querySelectorAll('[data-slot=aui_assistant-message-root] button[aria-expanded=false]')).reverse().forEach(b => b.click()))
    await sleep(400)
  }
  await shot('05-tool-cards')

  await page.click('^Open settings$')
  await sleep(1500)
  await shot('06-settings')
  await page.click('^Main model$', '[data-overlay-surface]')
  await sleep(700)
  await page.click('^This window$')
  await sleep(900)
  await shot('07-settings-gateway')
  await go('#/')
  await page.click('^Close$', '[data-overlay-surface]')
  await sleep(500)

  await go('#/capabilities')
  await shot('08-capabilities')
  await go('#/')
  await page.evaluate(() => { const e = document.querySelector('[data-slot=composer-root] [contenteditable=true]'); if (e) e.textContent = '' })

  // composer with the soft keyboard + a live approval prompt
  await page.tapSelector('[data-slot=composer-root] [contenteditable=true]') // a real tap summons the IME
  await sleep(1200)
  await page.type('@@approval device check')
  await shot('09-keyboard-composer')
  await page.evaluate(() => Array.from(document.querySelectorAll('[data-slot=composer-root] button')).filter(b => b.offsetParent && /send|submit/i.test(b.getAttribute('aria-label') || b.getAttribute('type') || ''))[0]?.click())
  await blur()
  await sleep(6000)
  await page.click('^Hide sidebar$')
  await sleep(600)
  await shot('10-approval-prompt')

  await page.click('gateway', '[data-slot=statusbar]')
  await sleep(900)
  await shot('11-gateway-popover')
  page.close()
} finally {
  adb('shell', 'wm', 'size', 'reset')
  adb('shell', 'wm', 'density', 'reset')
  console.log('wm size/density reset')
}
