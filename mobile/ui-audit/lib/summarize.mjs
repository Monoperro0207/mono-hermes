// node lib/summarize.mjs [rule] [severity]  - quick triage view of report.json
import fs from 'node:fs'
const r = JSON.parse(fs.readFileSync(new URL('../report.json', import.meta.url)))
const [rule, sev] = process.argv.slice(2)
const by = {}
for (const i of r.issues) { const k = `${i.rule}/${i.severity}`; by[k] = (by[k] || 0) + 1 }
console.log(Object.entries(by).sort().map(([k, v]) => `${k}:${v}`).join('  '))
for (const i of r.issues) {
  if (rule && i.rule !== rule) continue
  if (sev && i.severity !== sev) continue
  const vps = [...new Set(i.occurrences.map(o => o.viewport))].map(v => v.replace('fold-', '').replace('inner-', 'i-')).join(',')
  const scr = [...new Set(i.occurrences.map(o => o.screen))].slice(0, 3).join(',')
  console.log(`[${i.severity}] ${i.rule} | ${i.selector.slice(-90)} | "${i.text.slice(0, 30)}" | ${i.detail.slice(0, 110)} | ${vps} | ${scr}`)
}
