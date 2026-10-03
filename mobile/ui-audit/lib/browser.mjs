import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'

/** What a Fold4 reports through Capacitor SystemBars: status bar on top, gesture bar at the bottom. */
export const SAFE_AREA = { top: 24, bottom: 16, left: 0, right: 0 }

export const VIEWPORTS = {
  'fold-cover': { width: 344, height: 882, dpr: 2.625, label: 'Galaxy Z Fold4 cover (904x2316 px)' },
  'fold-inner-portrait': { width: 690, height: 829, dpr: 2.625, label: 'Galaxy Z Fold4 inner portrait (1812x2176 px)' },
  'fold-inner-landscape': { width: 829, height: 690, dpr: 2.625, label: 'Galaxy Z Fold4 inner landscape (2176x1812 px)' },
  phone: { width: 412, height: 915, dpr: 2.625, label: 'Generic 412x915 phone' },
  tablet: { width: 768, height: 1024, dpr: 2, label: 'Generic 768x1024 tablet' }
}

export function chromePath() {
  if (process.env.CHROME) return process.env.CHROME
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright')
  if (fs.existsSync(base)) {
    const dirs = fs.readdirSync(base).filter(d => /^chromium-\d+$/.test(d)).sort().reverse()
    for (const d of dirs) {
      const exe = path.join(base, d, 'chrome-win64', 'chrome.exe')
      if (fs.existsSync(exe)) return exe
    }
  }
  return undefined // let playwright-core resolve its own
}

export async function launch() {
  return chromium.launch({ executablePath: chromePath(), args: ['--disable-features=TranslateUI'] })
}

export async function newPage(browser, vp, { scheme = 'dark', origin = 'http://localhost:4176', extraCss = '', safeArea = SAFE_AREA } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.dpr,
    hasTouch: true,
    isMobile: true,
    colorScheme: scheme
  })
  await servePretext(ctx)
  // Capacitor's SystemBars exposes the system bar insets as CSS variables on a real device.
  await ctx.addInitScript(area => {
    const apply = () => {
      const st = document.createElement('style')
      st.textContent = `:root{--safe-area-inset-top:${area.top}px;--safe-area-inset-bottom:${area.bottom}px;--safe-area-inset-left:${area.left}px;--safe-area-inset-right:${area.right}px}`
      ;(document.head || document.documentElement).appendChild(st)
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply)
    else apply()
  }, safeArea)
  if (extraCss) {
    // live CSS iteration without a rebuild: appended last (re-appended after the lazy app CSS lands)
    await ctx.addInitScript(css => {
      const put = () => {
        document.getElementById('__audit_live_css')?.remove()
        const st = document.createElement('style')
        st.id = '__audit_live_css'
        st.textContent = css
        document.head.appendChild(st)
      }
      document.addEventListener('DOMContentLoaded', () => [0, 600, 1500, 3000, 6000].forEach(t => setTimeout(put, t)))
    }, extraCss)
  }
  const page = await ctx.newPage()
  const errors = []
  page.on('console', m => {
    if (m.type() === 'error') errors.push({ type: 'console.error', text: m.text().slice(0, 300) })
  })
  page.on('pageerror', e => errors.push({ type: 'pageerror', text: String(e.message).slice(0, 300) }))
  page.on('requestfailed', r => errors.push({ type: 'requestfailed', text: `${r.url().slice(0, 120)} ${r.failure()?.errorText}` }))
  await page.goto(`${origin}/__harness`)
  await page.waitForSelector('[data-contrib-shell], [data-titlebar-cluster]', { timeout: 60000 })
  await page.waitForTimeout(1500)
  return { ctx, page, errors }
}

import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const pretextDist = path.resolve(here, '../../node_modules/@chenglou/pretext/dist')

/** Serve the pretext ESM files from node_modules under /__audit/pretext/ so the page can import them. */
export async function servePretext(ctx) {
  await ctx.route('**/__audit/pretext/**', route => {
    const rel = new URL(route.request().url()).pathname.replace(/^.*\/__audit\/pretext\//, '')
    const file = path.join(pretextDist, rel)
    if (!file.startsWith(pretextDist) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'nf' })
    route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(file), headers: { 'access-control-allow-origin': '*' } })
  })
}
export const PRETEXT_URL = '/__audit/pretext/layout.js'
