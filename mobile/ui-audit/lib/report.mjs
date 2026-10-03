/**
 * Turns raw per-screen findings into report.json + REPORT.md.
 *
 * An "issue" groups identical findings (same rule + normalised selector + text) across screens
 * and viewports. Status is derived from the latest run: `open`, `waived` (ui-audit/waivers.json,
 * each with a written justification) or `fixed` (present in baseline.json, absent now).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SEV_ORDER = { high: 0, medium: 1, low: 2, info: 3 }

const norm = s =>
  String(s || '')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .slice(0, 70)

/**
 * Strips machine-specific paths from anything that ends up in a committed report
 * (page text such as Python tracebacks can contain the user's home directory).
 * The Hermes home is replaced first, then any user home directory.
 */
export function redact(value) {
  if (typeof value !== 'string') return value
  // Both separators are handled; `\\` below is a single backslash inside the character classes.
  let out = value.replace(/(?:[A-Za-z]:)?[\\/]+Users[\\/]+[^\\/\s"'`|]+[\\/]+AppData[\\/]+Local[\\/]+herme(?:s)?/gi, '<HERMES_HOME>')
  const home = os.homedir()
  if (home) {
    for (const v of new Set([home, home.replace(/\\/g, '/'), home.replace(/\\/g, '\\\\')])) out = out.split(v).join('<HOME>')
  }
  return out
    .replace(/(?:[A-Za-z]:)?[\\/]+Users[\\/]+[^\\/\s"'`|]+/g, '<HOME>')
    .replace(/\/(?:home|Users)\/[^/\s"'`|]+/g, '<HOME>')
    .replace(/<HOME>[\\/]+\.hermes\b/g, '<HERMES_HOME>')
}

function redactFinding(f) {
  return { ...f, selector: redact(f.selector), text: redact(f.text), detail: redact(f.detail) }
}

export function issueKey(f) {
  return `${f.rule}|${norm(f.selector)}|${norm(f.text)}`
}

export function buildReport({ results, viewports, dir, startedAt }) {
  const waiversFile = path.join(dir, 'waivers.json')
  const waivers = fs.existsSync(waiversFile) ? JSON.parse(fs.readFileSync(waiversFile, 'utf8')) : []
  const baselineFile = path.join(dir, 'baseline.json')
  const baseline = fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, 'utf8')) : null

  const issues = new Map()
  for (const r of results) {
    for (const f of r.findings.map(redactFinding)) {
      const key = issueKey(f)
      let issue = issues.get(key)
      if (!issue) {
        issue = { key, rule: f.rule, severity: f.severity, selector: f.selector, text: f.text, detail: f.detail, occurrences: [], status: 'open' }
        issues.set(key, issue)
      }
      if (SEV_ORDER[f.severity] < SEV_ORDER[issue.severity]) issue.severity = f.severity
      issue.occurrences.push({ viewport: r.viewport, screen: r.screen, screenshot: r.screenshot, rect: f.rect })
    }
  }

  for (const issue of issues.values()) {
    const w = waivers.find(w => (!w.rule || w.rule === issue.rule) && (!w.severity || w.severity === issue.severity) && (!w.selector || issue.selector.includes(w.selector)) && (!w.text || issue.text.includes(w.text)))
    if (w) {
      issue.status = 'waived'
      issue.waiver = w.reason
    }
  }

  const fixed = []
  if (baseline) {
    for (const b of baseline.issues) if (!issues.has(b.key) && b.severity !== 'info') fixed.push({ ...b, status: 'fixed' })
  }

  const list = [...issues.values()].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || b.occurrences.length - a.occurrences.length)

  const counts = {}
  for (const vp of viewports) counts[vp] = { high: 0, medium: 0, low: 0, info: 0 }
  for (const issue of list) {
    if (issue.status === 'waived') continue
    const seenVp = new Set(issue.occurrences.map(o => o.viewport))
    for (const vp of seenVp) if (counts[vp]) counts[vp][issue.severity]++
  }
  const total = { high: 0, medium: 0, low: 0, info: 0 }
  for (const issue of list) if (issue.status !== 'waived') total[issue.severity]++

  const report = {
    generatedAt: new Date().toISOString(),
    durationSec: Math.round((Date.now() - startedAt) / 1000),
    viewports,
    screens: [...new Set(results.map(r => r.screen))].length,
    snapshots: results.length,
    countsByViewport: counts,
    total,
    issues: list,
    fixedSinceBaseline: fixed,
    consoleErrors: results.flatMap(r => (r.consoleErrors || []).map(e => ({ viewport: r.viewport, screen: r.screen, ...e, text: redact(e.text) }))),
    textFit: results.reduce((a, r) => ({ checked: a.checked + (r.mismatch?.checked || 0), lineCountDiffers: a.lineCountDiffers + (r.mismatch?.lineCountDiffers || 0) }), { checked: 0, lineCountDiffers: 0 })
  }

  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2))
  fs.writeFileSync(path.join(dir, 'REPORT.md'), toMarkdown(report))
  return report
}

const rel = p => (p ? p.split(path.sep).join('/') : '')

function toMarkdown(r) {
  const L = []
  L.push('# UI audit report', '')
  L.push(`Generated ${r.generatedAt} in ${r.durationSec}s - ${r.snapshots} snapshots over ${r.screens} screens/states, viewports: ${r.viewports.join(', ')}.`, '')
  L.push('Regenerate with `npm run ui:audit` (in `mobile/`). Screenshots: `mobile/ui-audit/screens/<viewport>/<screen>.png` (git-ignored).', '')
  L.push('## Open issues by viewport (excluding waived)', '')
  L.push('| viewport | high | medium | low |', '|---|---:|---:|---:|')
  for (const vp of r.viewports) L.push(`| ${vp} | ${r.countsByViewport[vp].high} | ${r.countsByViewport[vp].medium} | ${r.countsByViewport[vp].low} |`)
  L.push(`| **unique issues** | **${r.total.high}** | **${r.total.medium}** | **${r.total.low}** |`, '')
  L.push(`Text-fit engine: ${r.textFit.checked} text boxes measured with pretext; pretext and the browser disagreed on the line count for ${r.textFit.lineCountDiffers} of them (font metric differences, informational).`, '')
  if (r.consoleErrors.length) {
    L.push('## Console errors', '')
    const seen = new Map()
    for (const e of r.consoleErrors) {
      const k = e.text.slice(0, 120)
      if (!seen.has(k)) seen.set(k, { ...e, n: 0 })
      seen.get(k).n++
    }
    for (const e of seen.values()) L.push(`- (${e.n}x) \`${e.type}\` ${e.text.replace(/\n/g, ' ').slice(0, 200)} - first at ${e.viewport}/${e.screen}`)
    L.push('')
  }
  const waived = r.issues.filter(i => i.status === 'waived')
  if (waived.length) {
    L.push(`## Accepted (waived) issues: ${waived.length}`, '')
    const groups = new Map()
    for (const i of waived) {
      const k = `${i.rule} / ${i.severity}`
      if (!groups.has(k)) groups.set(k, { n: 0, reason: i.waiver })
      groups.get(k).n++
    }
    for (const [k, g] of groups) L.push(`- **${k}** (${g.n}): ${g.reason}`)
    L.push('', 'They stay listed below with status `waived`; `ui-audit/waivers.json` is the source of the reasons.', '')
  }
  for (const sev of ['high', 'medium', 'low']) {
    const items = r.issues.filter(i => i.severity === sev)
    if (!items.length) continue
    L.push(`## ${sev[0].toUpperCase() + sev.slice(1)} severity (${items.length})`, '')
    L.push('| # | rule | element / text | detail | where | status |', '|---|---|---|---|---|---|')
    items.forEach((i, n) => {
      const vps = [...new Set(i.occurrences.map(o => o.viewport))].join(', ')
      const first = i.occurrences[0]
      const where = `${first.screen} (${vps})${first.screenshot ? ` - [shot](${rel(first.screenshot)})` : ''}`
      const status = i.status === 'waived' ? `waived: ${i.waiver}` : i.status
      L.push(`| ${n + 1} | ${i.rule} | \`${i.selector.slice(-70).replace(/\|/g, '/')}\` ${i.text ? '"' + i.text.replace(/\|/g, '/').slice(0, 40) + '"' : ''} | ${i.detail.replace(/\|/g, '/').slice(0, 150)} | ${where} | ${status} |`)
    })
    L.push('')
  }
  if (r.fixedSinceBaseline.length) {
    L.push(`## Fixed since the baseline run (${r.fixedSinceBaseline.length})`, '')
    L.push('| rule | element / text | severity then | status |', '|---|---|---|---|')
    for (const i of r.fixedSinceBaseline.slice(0, 400)) L.push(`| ${i.rule} | \`${String(i.selector).slice(-70).replace(/\|/g, '/')}\` ${i.text ? '"' + String(i.text).replace(/\|/g, '/').slice(0, 40) + '"' : ''} | ${i.severity} | fixed |`)
    L.push('')
  }
  return L.join('\n')
}
