# UI audit progress

Status: DONE. Last full `npm run ui:audit` (build + throwaway gateway, all 5 viewports, 37 scenarios,
~1000 snapshots): **0 high / 0 medium / 0 open low** at fold-cover (344x882), fold-inner-portrait
(690x829), fold-inner-landscape (829x690), phone (412x915), tablet (768x1024). 273 low findings
(touch targets 24-43px, 9-10px metadata badges) are waived in `waivers.json` with written reasons.
Baseline (before fixes, same tool): 144 high / 219 medium / 209 low unique issues.

Verification at the end: `npx tsc --noEmit -p mobile` clean, `npx vitest run` 28/28, e2e 12/12,
`scripts/build-apk.ps1 -DebugOnly` -> `apk/hermes-mobile-debug.apk` (21.6 MB), emulator spot check
(`device/cover-*.png`, `device/inner-*.png`) done, `wm size/density` reset.

Where things are
- `mobile/src/mobile.css` all phone CSS; `src/composer-touch.ts` (Enter = newline, no keyboard pop on
  autofocus); `src/bridge/api.ts` (update-probe mask); `src/entry.ts` (comfortable rows default).
- `ui-audit/run.mjs` runner (`--viewports`, `--only`, `--no-build`, `--attach`, `--css-live`,
  `--baseline`); `scenarios.mjs`; `lib/page-checks.mjs` (pretext text fit, overflow, overlap,
  touch targets ...); `serve.mjs` (keep fixtures up), `device-server.mjs` + `device-shots.mjs`
  (emulator); `REPORT.md`/`report.json` (latest), `BASELINE-REPORT.md`/`baseline.json` (before).

Resume recipe if something changes: `cd mobile && npm run ui:audit` (about 13 min); for a quick loop
`node ui-audit/serve.mjs --build` in one terminal, then
`node ui-audit/run.mjs --attach --css-live --viewports fold-cover --only <scenario ids>`.
Remember an attached harness serves the dist of its last build: rebuild after removing CSS rules.
