/**
 * Device regression check: system ROTATION in the real Android WebView (GitHub issue #2).
 *
 *   node ui-audit/device-rotation.mjs [label] [profiles]
 *     label     file prefix under mobile/ui-audit/device/ (default "after")
 *     profiles  comma list of phone,fold-cover,fold-inner,tablet (default: all four)
 *
 * Needs `node ui-audit/device-server.mjs` running and the debug APK installed on an emulator/device.
 * For every profile (`adb shell wm size/density`) the app starts from clean data (emulator only),
 * signs in with the throwaway credentials from mobile/.env.test (never printed) and, for each state,
 * rotates with the real system rotation (`settings put system user_rotation`, auto-rotate off):
 *   open the state at orientation A -> B -> A -> B   (A = natural, or the other one for *-land states)
 * States: idle (+ the reverse landscape 0 -> 3 -> 0), left sidebar opened in either orientation, right
 * rail opened in either orientation, soft keyboard up in the composer, a live streaming turn (mock
 * `@@ticker`), Settings open.
 * After every rotation (and a settle) it measures the page and checks:
 *   - the viewport follows the rotation (orientation flips, html client size == inner size, no scroll)
 *   - no horizontal overflow
 *   - the app shell fills the viewport inside the safe areas
 *   - no blank layout track: every displayed tree track holds a displayed pane zone
 *   - narrow (< 640px): the chat pane spans the whole shell (side panes are overlays, none docked)
 *   - wide: no narrow edge overlay left open
 *   - the composer is on screen; with the soft keyboard up, the row being typed into is above it
 *     (and the orientation is read from the screen, since the keyboard shrinks the viewport)
 *   - Settings: the overlay covers the viewport and does not overflow
 *   - coming back to an orientation gives the same layout it had there before (nothing stuck)
 * ROTATION_STATES=keyboard,settings limits the run to some states.
 * Saves screenshots (rotation-<label>-<profile>-<state>-<step>.png) and rotation-<label>.json.
 * Always restores auto-rotate / user_rotation and resets `wm size` / `wm density`.
 * Exit code 1 when any check fails.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { adb, connect, launchApp, loadEnv, signIn, sleep } from './lib/device.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, 'device')
fs.mkdirSync(out, { recursive: true })

const PROFILES = {
  phone: { size: '1080x2400', density: '420' },
  'fold-cover': { size: '904x2316', density: '420' },
  'fold-inner': { size: '2176x1812', density: '420' },
  tablet: { size: '2800x1752', density: '440' }
}

const label = process.argv[2] ?? 'after'
const profiles = (process.argv[3] ?? Object.keys(PROFILES).join(',')).split(',').filter(Boolean)
const SETTLE = 2500

for (const p of profiles) if (!PROFILES[p]) throw new Error(`unknown profile ${p} (${Object.keys(PROFILES).join(', ')})`)

const env = loadEnv()

const setting = key => adb('shell', 'settings', 'get', 'system', key).toString().trim()
const original = { auto: setting('accelerometer_rotation'), user: setting('user_rotation') }
const rotate = n => {
  adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0')
  adb('shell', 'settings', 'put', 'system', 'user_rotation', String(n))
}
const imeShown = () => {
  try {
    return /mInputShown=true/.test(adb('shell', 'dumpsys', 'input_method').toString())
  } catch {
    return false
  }
}

/** Everything the checks need, measured in the page. */
function measure() {
  const rect = el => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
  }
  const shown = el => {
    for (let e = el; e && e !== document.body; e = e.parentElement) if (getComputedStyle(e).display === 'none') return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const root = document.getElementById('root')
  const rs = getComputedStyle(root)
  const de = document.documentElement
  const vv = window.visualViewport
  const shell = document.querySelector('[data-contrib-shell]')
  // tree tracks: the direct children of every split container; a displayed one must hold a displayed zone
  const blankTracks = Array.from(document.querySelectorAll('[data-tree-split]'))
    .flatMap(split => Array.from(split.children))
    .filter(track => shown(track) && track.getBoundingClientRect().width > 2 && track.getBoundingClientRect().height > 2)
    .filter(track => !Array.from(track.querySelectorAll('[data-tree-group]')).some(shown))
    .map(track => ({ ...rect(track), in: track.parentElement.getAttribute('data-tree-split'), style: track.getAttribute('style') }))
  const main = Array.from(document.querySelectorAll('[data-tree-group=grp-main]')).find(shown)
  const overlay = document.querySelector('[data-overlay-surface]')
  return {
    inner: { w: innerWidth, h: innerHeight },
    // the soft keyboard shrinks the viewport (portrait 654x485 on the Fold inner screen looks landscape);
    // the screen orientation is what the rotation set
    orientation: screen.orientation?.type ?? null,
    client: { w: de.clientWidth, h: de.clientHeight },
    vv: vv ? { w: Math.round(vv.width), h: Math.round(vv.height), top: Math.round(vv.offsetTop), scale: vv.scale } : null,
    scroll: { w: Math.max(de.scrollWidth, document.body.scrollWidth), x: Math.round(scrollX), y: Math.round(scrollY) },
    safe: { t: parseFloat(rs.paddingTop), r: parseFloat(rs.paddingRight), b: parseFloat(rs.paddingBottom), l: parseFloat(rs.paddingLeft) },
    narrow: matchMedia('(max-width: 639.98px)').matches,
    shell: rect(shell),
    main: rect(main),
    blankTracks,
    sideZones: Array.from(document.querySelectorAll('[data-tree-group]'))
      .filter(g => shown(g) && g.getAttribute('data-tree-group') !== 'grp-main')
      .map(g => ({ id: g.getAttribute('data-tree-group'), ...rect(g) })),
    narrowOverlay: rect(Array.from(document.querySelectorAll('[data-narrow-overlay]')).find(shown)),
    composer: rect(Array.from(document.querySelectorAll('[data-slot=composer-root]')).find(shown)),
    // the row being typed into: with the keyboard up in an 82px landscape strip only this row has to fit
    editor: rect(Array.from(document.querySelectorAll('[data-slot=composer-root] [contenteditable=true]')).find(shown)),
    overlay: overlay && shown(overlay) ? { ...rect(overlay), scrollW: overlay.scrollWidth, clientW: overlay.clientWidth } : null,
    ticker: !!document.querySelector('[data-tool-ticker]')
  }
}

const near = (a, b, tol = 2) => Math.abs(a - b) <= tol

/** Objective checks for one measurement. `landscape` is what the rotation should have produced. */
function check(m, { landscape, state, ime }) {
  const fails = []
  const fail = (what, detail) => fails.push({ what, detail })
  const isLandscape = ime && m.orientation ? m.orientation.startsWith('landscape') : m.inner.w > m.inner.h
  if (isLandscape !== landscape) fail('viewport did not follow the rotation', { inner: m.inner, orientation: m.orientation })
  if (m.client.w !== m.inner.w || m.client.h !== m.inner.h) fail('html client size != viewport', { client: m.client, inner: m.inner })
  if (m.scroll.x || m.scroll.y) fail('page is scrolled', m.scroll)
  if (m.scroll.w > m.inner.w + 1) fail('horizontal overflow', { scrollW: m.scroll.w, innerW: m.inner.w })
  const fillW = m.inner.w - m.safe.l - m.safe.r
  const fillH = m.inner.h - m.safe.t - m.safe.b
  if (!m.shell || !near(m.shell.w, fillW) || !near(m.shell.h, fillH)) fail('app shell does not fill the viewport', { shell: m.shell, expect: { w: fillW, h: fillH } })
  if (m.blankTracks.length) fail('blank layout track (column with no visible pane)', m.blankTracks)
  if (m.narrow) {
    if (!m.main || !near(m.main.w, m.shell?.w ?? 0)) fail('narrow: chat pane does not span the shell', { main: m.main, shell: m.shell, sideZones: m.sideZones })
    if (m.sideZones.length) fail('narrow: side pane docked in the grid', m.sideZones)
  } else if (m.narrowOverlay) fail('wide: narrow edge overlay still open', m.narrowOverlay)
  if (state !== 'settings') {
    // keyboard up: the row being typed into must be fully visible; the status stack above it may scroll off
    const c = ime && m.editor ? m.editor : m.composer
    const bottom = ime && m.vv ? m.vv.h : m.inner.h
    if (!c) fail('composer missing', null)
    else if (c.y < 0 || c.x < -1 || c.x + c.w > m.inner.w + 1 || c.y + c.h > bottom + 1) fail(ime ? 'composer hidden behind the keyboard / off screen' : 'composer off screen', { composer: c, inner: m.inner, vv: m.vv })
  } else if (!m.overlay || !near(m.overlay.w, m.inner.w) || !near(m.overlay.h, m.inner.h) || m.overlay.scrollW > m.overlay.clientW + 1) {
    fail('settings overlay does not cover the viewport', { overlay: m.overlay, inner: m.inner })
  }
  return fails
}

/** Layout fingerprint compared between two visits of the same orientation. */
const fingerprint = m => ({ inner: m.inner, shell: m.shell, main: m.main, composer: m.composer, sideZones: m.sideZones.map(z => `${z.id}:${z.w}x${z.h}`).join(' '), overlay: m.overlay && { w: m.overlay.w, h: m.overlay.h } })
const sameLayout = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const report = { label, profiles: {}, failures: [] }

async function runProfile(name) {
  const { size, density } = PROFILES[name]
  const [W, H] = size.split('x').map(Number)
  const naturalLandscape = W > H
  adb('shell', 'wm', 'size', size)
  adb('shell', 'wm', 'density', density)
  rotate(0)
  // Force-stop + (emulator only) clean app data, so every profile starts from the default layout.
  await launchApp()
  const cdp = await connect()
  try {
    await signIn(cdp, env)
    await sleep(2500)

    const blur = () => cdp.evaluate(() => document.activeElement?.blur())
    const hideKeyboard = async () => {
      await blur()
      if (imeShown()) adb('shell', 'input', 'keyevent', '111') // ESCAPE closes the IME without leaving the app
      await sleep(400)
    }
    const home = async () => {
      await cdp.evaluate(() => (location.hash = '#/'))
      await sleep(800)
      for (let i = 0; i < 3; i++) await cdp.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
      await cdp.evaluate(() => Array.from(document.querySelectorAll('button[aria-label="Dismiss notification"]')).forEach(b => b.click()))
      await hideKeyboard()
    }
    const toggle = async (show, hide, open) => {
      // the titlebar toggle's own label is the source of truth
      if (await cdp.evaluate((s, h, o) => Array.from(document.querySelectorAll('button')).some(b => b.offsetParent && b.getAttribute('aria-label') === (o ? s : h)), show, hide, open)) {
        await cdp.tap('button', open ? show : hide)
      }
    }
    const sidebar = open => toggle('Show sidebar', 'Hide sidebar', open)
    const rail = open => toggle('Show right sidebar', 'Hide right sidebar', open)

    const STATES = [
      { name: 'idle', at: 0, extra: true },
      { name: 'sidebar-port', at: 0, setup: () => sidebar(true), teardown: () => sidebar(false) },
      { name: 'sidebar-land', at: 1, setup: () => sidebar(true), teardown: () => sidebar(false) },
      { name: 'rail-port', at: 0, setup: () => rail(true), teardown: () => rail(false) },
      { name: 'rail-land', at: 1, setup: () => rail(true), teardown: () => rail(false) },
      {
        name: 'keyboard',
        at: 0,
        ime: true,
        setup: async () => {
          await cdp.tap('[data-slot=composer-root] [contenteditable=true]') // a real tap summons the IME
          await sleep(1200)
        },
        teardown: hideKeyboard
      },
      {
        name: 'streaming',
        at: 0,
        setup: async () => {
          await cdp.evaluate(() => document.querySelector('[data-slot=composer-root] [contenteditable=true]')?.focus())
          await cdp.send('Input.insertText', { text: '@@ticker rotation check' })
          await sleep(400)
          await cdp.evaluate(() => document.querySelector('[data-slot=composer-root] button[aria-label=Send]')?.click())
          await hideKeyboard()
          await sleep(2500)
        },
        teardown: async () => {
          // let the turn finish so the next state starts idle
          for (let i = 0; i < 40 && (await cdp.evaluate(() => !!document.querySelector('[data-tool-ticker]') || Array.from(document.querySelectorAll('[data-slot=composer-root] button')).some(b => /^(Stop|Cancel)/i.test(b.getAttribute('aria-label') || '')))); i++) await sleep(1000)
        }
      },
      { name: 'settings', at: 0, setup: () => cdp.tap('button', 'Open settings'), teardown: home }
    ]

    const results = []
    const only = (process.env.ROTATION_STATES ?? '').split(',').filter(Boolean)
    for (const st of STATES.filter(s => !only.length || only.includes(s.name))) {
      await home()
      rotate(st.at)
      await sleep(SETTLE)
      await st.setup?.()
      const other = st.at === 0 ? 1 : 0
      const seq = [st.at, other, st.at, other, ...(st.extra ? [st.at, 3, st.at] : [])]
      const seen = {}
      const steps = []
      for (const [i, rot] of seq.entries()) {
        if (i > 0) {
          rotate(rot)
          await sleep(SETTLE)
        }
        const ime = st.ime ? imeShown() : false
        const m = await cdp.evaluate(measure)
        const landscape = rot % 2 === 1 ? !naturalLandscape : naturalLandscape
        const fails = check(m, { landscape, state: st.name, ime })
        const fp = fingerprint(m)
        // the streaming turn changes the transcript between visits; the keyboard may not survive the
        // rotation: compare only states whose content is static between two visits
        // (Android may hand the window a slightly different size on a later visit - e.g. the large-screen
        // taskbar inset settling after the first rotation; the fill checks above cover that case.)
        if (seen[rot] && !st.ime && st.name !== 'streaming' && sameLayout(seen[rot].inner, fp.inner) && !sameLayout(seen[rot], fp)) fails.push({ what: `layout at rotation ${rot} differs from the previous visit`, detail: { before: seen[rot], after: fp } })
        seen[rot] ??= fp
        const shot = `rotation-${label}-${name}-${st.name}-${i}-r${rot}.png`
        fs.writeFileSync(path.join(out, shot), adb('exec-out', 'screencap', '-p'))
        steps.push({ step: i, rotation: rot, ime, shot, measure: m, fails })
        for (const f of fails) report.failures.push({ profile: name, state: st.name, step: i, rotation: rot, ...f })
        console.log(`${name} ${st.name} #${i} r${rot} ${m.inner.w}x${m.inner.h}${ime ? ' ime' : ''}: ${fails.length ? 'FAIL ' + fails.map(f => f.what).join('; ') : 'ok'}`)
      }
      results.push({ state: st.name, steps })
      rotate(st.at)
      await sleep(SETTLE)
      await st.teardown?.()
    }
    report.profiles[name] = { size, density, results }
  } finally {
    cdp.close()
  }
}

let crashed = null
try {
  for (const p of profiles) await runProfile(p)
} catch (error) {
  crashed = error
  console.error(error)
} finally {
  adb('shell', 'settings', 'put', 'system', 'user_rotation', original.user === 'null' ? '0' : original.user)
  adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', original.auto === 'null' ? '1' : original.auto)
  adb('shell', 'wm', 'size', 'reset')
  adb('shell', 'wm', 'density', 'reset')
  fs.writeFileSync(path.join(out, `rotation-${label}.json`), JSON.stringify(report, null, 2))
  console.log(`rotation ${label}: ${report.failures.length} failing checks; rotation + wm size/density restored`)
}
process.exit(crashed || report.failures.length ? 1 : 0)
