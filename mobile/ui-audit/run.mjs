/**
 * `npm run ui:audit` - repeatable mobile UI audit.
 *
 *   node ui-audit/run.mjs [--no-build] [--viewports a,b] [--only id,id] [--parallel N]
 *                         [--baseline] [--scheme dark|light] [--css-live] [--attach]
 *
 * 1. vite build (the production bundle the APK ships)
 * 2. mock OpenAI-compatible model + seed the throwaway Hermes home (.cache/hm) with stress data
 * 3. start the harness (throwaway gated `hermes serve` on a random port + preview on :4176)
 * 4. drive the REAL renderer with Playwright (mobile emulation, touch, device pixel ratio) through
 *    every scenario x viewport, screenshot each state, run the page-side checks (pretext text fit,
 *    overflow, overlap, touch targets, hover-only, dialogs, console errors)
 * 5. write ui-audit/report.json + REPORT.md (+ baseline.json with --baseline)
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { launch, newPage, VIEWPORTS, PRETEXT_URL } from './lib/browser.mjs'
import { pageChecks } from './lib/page-checks.mjs'
import { buildReport } from './lib/report.mjs'
import { build, ensureSchema, MOBILE, seed, startHarness, startMock } from './lib/services.mjs'
import { SCENARIOS } from './scenarios.mjs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = n => args.includes(`--${n}`)
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}

const startedAt = Date.now()
const vpNames = (opt('viewports', '') || Object.keys(VIEWPORTS).join(',')).split(',').filter(Boolean)
const only = (opt('only', '') || '').split(',').filter(Boolean)
const parallel = Number(opt('parallel', '3'))
const scheme = opt('scheme', 'dark')
// --css-live: iterate on src/mobile.css without rebuilding (it is appended last, like the real import)
const extraCss = flag('css-live') ? fs.readFileSync(path.join(MOBILE, 'src/mobile.css'), 'utf8') : ''
const allScenarios = SCENARIOS.filter(s => !only.length || only.some(o => s.id === o || s.id.startsWith(o)))
const scenarios = allScenarios.filter(s => !s.exclusive)
const exclusive = allScenarios.filter(s => s.exclusive)

const services = []
const cleanup = async () => {
  for (const s of services.reverse()) {
    try {
      await s.stop()
    } catch {
      /* ignore */
    }
  }
}
process.on('SIGINT', () => void cleanup().then(() => process.exit(130)))

try {
  if (flag('attach')) {
    // reuse a harness already started with `node ui-audit/serve.mjs` (fast CSS iteration loop)
    console.log('[audit] attaching to the running harness on :4176')
  } else {
    if (!flag('no-build')) build()
    const mock = await startMock()
    services.push({ stop: mock.close })
    await ensureSchema()
    seed(mock.url)
    const harness = await startHarness()
    services.push(harness)
    console.log(`[audit] harness up (gateway ${harness.gateway}); ${scenarios.length} scenarios x ${vpNames.length} viewports`)
  }

  const browser = await launch()
  services.push({ stop: () => browser.close() })

  const results = []
  const wiped = new Set()
  let queue = [...vpNames]
  let active = scenarios
  const worker = async () => {
    while (queue.length) {
      const name = queue.shift()
      const vp = VIEWPORTS[name]
      if (!vp) throw new Error(`unknown viewport ${name}`)
      const shotDir = path.join(dir, 'screens', name)
      if (!wiped.has(name) && !only.length) {
        wiped.add(name)
        fs.rmSync(shotDir, { recursive: true, force: true })
      }
      fs.mkdirSync(shotDir, { recursive: true })
      const t0 = Date.now()
      let { ctx, page, errors } = await newPage(browser, vp, { scheme, extraCss })
      let n = 0
      for (const sc of active) {
        const sink = []
        const ctxApi = {
          page,
          vp,
          vpName: name,
          scheme,
          browser,
          results: sink,
          /** Capture the current UI state: screenshot + checks. */
          async snap(label = '', opts = {}) {
            const screen = label ? `${sc.id}--${label}` : sc.id
            const file = path.join(shotDir, `${screen.replace(/[^a-z0-9._-]+/gi, '_')}.png`)
            await page.waitForTimeout(opts.settle ?? 350)
            await page.screenshot({ path: file }).catch(() => {})
            let res = { findings: [], counts: {}, mismatch: {} }
            try {
              res = await page.evaluate(pageChecks, { pretextUrl: PRETEXT_URL, maxPerRule: opts.maxPerRule ?? 12 })
            } catch (e) {
              res.findings.push({ rule: 'audit-error', severity: 'info', selector: 'page.evaluate', text: '', rect: [0, 0, 0, 0], detail: String(e.message).slice(0, 200) })
            }
            const consoleErrors = errors.splice(0).filter(e => !/ERR_ABORTED|ERR_NETWORK_CHANGED|favicon|Failed to load resource: the server responded with a status of 404/.test(e.text))
            sink.push({ viewport: name, screen, screenshot: path.relative(MOBILE, file), findings: res.findings, mismatch: res.mismatch, consoleErrors })
            return res
          }
        }
        try {
          await sc.run(ctxApi)
          if (!sink.length) await ctxApi.snap()
        } catch (e) {
          const at = /scenarios\.mjs:(\d+)/.exec(String(e.stack || ''))
          const msg = String(e.message || e).split('\n')[0].slice(0, 200) + (at ? ` (scenarios.mjs:${at[1]})` : '')
          console.log(`  [${name}] ${sc.id}: FAILED ${msg}`)
          let shot = ''
          try {
            shot = path.join(shotDir, `${sc.id}--failed.png`)
            await page.screenshot({ path: shot })
          } catch {
            shot = ''
          }
          sink.push({
            viewport: name,
            screen: sc.id,
            screenshot: shot ? path.relative(MOBILE, shot) : '',
            findings: [{ rule: 'scenario-failed', severity: sc.criticalIfFails ? 'high' : 'medium', selector: sc.id, text: sc.title, rect: [0, 0, 0, 0], detail: `could not complete: ${msg}` }],
            consoleErrors: []
          })
          // a crashed page / dead context: rebuild it so the remaining scenarios still run
          if (page.isClosed()) {
            await ctx.close().catch(() => {})
            ;({ ctx, page, errors } = await newPage(browser, vp, { scheme, extraCss }))
          }
        }
        results.push(...sink)
        n++
        if (sc.reload) {
          await ctx.close().catch(() => {})
          ;({ ctx, page, errors } = await newPage(browser, vp, { scheme, extraCss }))
        }
      }
      await ctx.close()
      console.log(`[audit] ${name}: ${n} scenarios in ${Math.round((Date.now() - t0) / 1000)}s`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, vpNames.length) }, worker))
  // scenarios that mutate the shared throwaway server (config swaps) run alone, one viewport at a time
  if (exclusive.length) {
    queue = [...vpNames]
    active = exclusive
    await worker()
  }

  const report = buildReport({ results, viewports: vpNames, dir, startedAt })
  if (flag('baseline')) {
    fs.writeFileSync(path.join(dir, 'baseline.json'), JSON.stringify({ generatedAt: report.generatedAt, issues: report.issues.map(i => ({ key: i.key, rule: i.rule, severity: i.severity, selector: i.selector, text: i.text })) }, null, 1))
    console.log('[audit] baseline.json written')
  }
  console.log('\n[audit] open issues (unique, excluding waived):', JSON.stringify(report.total))
  for (const vp of vpNames) console.log(`  ${vp.padEnd(22)} high ${report.countsByViewport[vp].high}  medium ${report.countsByViewport[vp].medium}  low ${report.countsByViewport[vp].low}`)
  console.log(`[audit] report: ${path.join('ui-audit', 'REPORT.md')}`)
  await cleanup()
  process.exit(report.total.high + report.total.medium > 0 && flag('strict') ? 1 : 0)
} catch (e) {
  console.error('[audit] failed:', e)
  await cleanup()
  process.exit(2)
}
