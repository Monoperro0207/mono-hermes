/**
 * Audit scenarios: every screen / state of the renderer worth looking at on a phone.
 *
 * A scenario drives the real UI (English locale) to a state and calls `snap(label)`, which
 * screenshots the page and runs the page-side checks. If no snap is taken the final state is
 * captured. Selectors use accessible names / data-slot hooks; when upstream renames something the
 * scenario fails loudly as `scenario-failed` instead of silently passing.
 */

import fs from 'node:fs'
import path from 'node:path'

import { HOME } from './lib/services.mjs'

const T = 4000 // per-action timeout

// ------------------------------------------------------------------------------ helpers
export async function dismissToasts(page) {
  for (const b of await page.getByRole('button', { name: 'Dismiss notification' }).all()) await b.click({ timeout: 800 }).catch(() => {})
  await page.waitForTimeout(150)
}

export async function reset(page) {
  await page.evaluate(() => {
    location.hash = '#/'
  })
  await page.waitForTimeout(250)
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(120)
  }
  await dismissToasts(page)
}

/** Close open menus / popovers / dialogs but leave slide-over panes (sidebar) alone. */
export async function closeLayers(page) {
  for (let i = 0; i < 4; i++) {
    const open = await page.locator('[role=menu], [role=dialog][data-state=open], [role=listbox], [data-radix-popper-content-wrapper], [role=alertdialog]').first().isVisible().catch(() => false)
    if (!open) break
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
  }
  await dismissToasts(page)
}

export async function go(page, hash, wait = 1800) {
  await page.evaluate(h => {
    location.hash = h
  }, hash)
  await page.waitForTimeout(wait)
}

export const click = (page, name, opts = {}) => page.getByRole(opts.role || 'button', { name, exact: opts.exact ?? false }).first().click({ timeout: T })
export const clickText = (page, text, opts = {}) => page.getByText(text, { exact: opts.exact ?? false }).first().click({ timeout: T })

export async function sidebarOpen(page) {
  return page.locator('input[placeholder^="Search sessions"]:not([data-overlay-surface] *, [role=dialog] *)').first().isVisible().catch(() => false)
}

export async function ensureSidebar(page, open) {
  // the titlebar toggle's own label is the source of truth: "Show sidebar" when closed, "Hide sidebar" when open
  const toggle = page.getByRole('button', { name: open ? 'Show sidebar' : 'Hide sidebar' }).first()

  if (await toggle.isVisible().catch(() => false)) {
    await toggle.click({ timeout: T })
    await page.waitForTimeout(700)
  }
}

/** Find a seeded session row through the sidebar search (live turns from other viewports crowd the list). */
export async function findSessionRow(page, title) {
  const input = page.locator('input[placeholder^="Search sessions"]:not([data-overlay-surface] *, [role=dialog] *)').first()
  if (!(await input.isVisible().catch(() => false))) {
    // a previous scenario may have left the Bots tab selected
    await page.locator('[data-slot=pane-tab]').filter({ hasText: /^sessions$/i }).first().click({ timeout: 2000 }).catch(() => {})
    await page.waitForTimeout(400)
  }
  await input.fill(title, { timeout: 5000 })
  await page.waitForTimeout(900)
  return page.getByRole('button', { name: title, exact: true }).first()
}

export async function composer(page) {
  const ed = page.locator('[data-slot=composer-root] [contenteditable=true], [data-slot=composer-root] textarea').first()
  await ed.waitFor({ timeout: T })
  return ed
}

export async function typeInComposer(page, text) {
  const ed = await composer(page)
  await ed.click({ timeout: T })
  await page.keyboard.type(text, { delay: 5 })
}

export async function newChat(page) {
  await go(page, '#/', 1200)
}

/** Settings navigation works on both layouts (wide rail / narrow dropdown). */
export async function openSettings(page) {
  await dismissToasts(page)
  await page.getByRole('button', { name: 'Open settings' }).first().click({ timeout: T })
  await page.waitForTimeout(1200)
}

export async function settingsLayout(page) {
  const rail = page.locator('[data-tour="overlay-nav"]').first()
  const railVisible = await rail.isVisible().catch(() => false)
  return railVisible ? 'rail' : 'dropdown'
}

export async function settingsItems(page) {
  const layout = await settingsLayout(page)
  if (layout === 'rail') {
    return { layout, names: await page.locator('[data-tour="overlay-nav"] button[data-tour^="nav-"]').evaluateAll(bs => bs.map(b => (b.textContent || '').trim()).filter(Boolean)) }
  }
  const trigger = page.locator('[data-slot=dropdown-menu-trigger][aria-haspopup=menu]').filter({ hasNot: page.locator('svg.hidden') }).first()
  await page.locator('main [data-slot=dropdown-menu-trigger], [data-overlay-surface] [data-slot=dropdown-menu-trigger]').first().click({ timeout: T })
  await page.waitForTimeout(500)
  const names = await page.locator('[role=menuitem], [role=menuitemradio]').evaluateAll(es => es.map(e => (e.textContent || '').trim()).filter(Boolean))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  void trigger
  return { layout, names }
}

export async function gotoSettingsItem(page, layout, name) {
  if (layout === 'rail') {
    await page.locator('[data-tour="overlay-nav"]').getByRole('button', { name, exact: true }).first().click({ timeout: T })
  } else {
    await page.locator('main [data-slot=dropdown-menu-trigger], [data-overlay-surface] [data-slot=dropdown-menu-trigger]').first().click({ timeout: T })
    await page.waitForTimeout(350)
    await page.getByRole('menuitem', { name, exact: true }).first().click({ timeout: T })
  }
  await page.waitForTimeout(700)
}

const openSession = async (page, id, wait = 2600) => {
  await go(page, `#/${id}`, wait)
}

async function expandToolCards(page) {
  // tool groups / tool cards / thinking blocks are disclosure buttons (aria-expanded=false)
  for (let round = 0; round < 3; round++) {
    const closed = page.locator('[data-slot=aui_assistant-message-root] button[aria-expanded=false]')
    const n = await closed.count()
    if (!n) break
    for (let i = n - 1; i >= 0; i--) await closed.nth(i).click({ timeout: 800 }).catch(() => {})
    await page.waitForTimeout(300)
  }
}

async function scrollThread(page, where) {
  await page.evaluate(w => {
    const sc = Array.from(document.querySelectorAll('*')).filter(e => e.scrollHeight > e.clientHeight + 40 && /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.clientHeight > 200)
    sc.sort((a, b) => b.scrollHeight - a.scrollHeight)
    const el = sc[0]
    if (!el) return
    el.scrollTop = w === 'top' ? 0 : w === 'mid' ? (el.scrollHeight - el.clientHeight) / 2 : el.scrollHeight
  }, where)
  await page.waitForTimeout(500)
}

// ------------------------------------------------------------------------------ scenarios
export const SCENARIOS = []
const S = (id, area, title, run, extra = {}) => SCENARIOS.push({ id, area, title, run, ...extra })

// --- shell / sidebar ---------------------------------------------------------------------
S('home', 'shell', 'New chat landing (with first-launch banners)', async ({ page, snap }) => {
  await snap('with-banners', { settle: 1500 })
  // the "Update ready" toast (server update status) opens the update overlay
  await page.getByRole('button', { name: "See what's new" }).first().click({ timeout: 2500 }).then(() => snap('update-overlay', { settle: 900 })).catch(() => {})
  await reset(page)
  await snap('clean')
})

S('sidebar', 'sidebar', 'Sidebar: sessions list', async ({ page, snap }) => {
  await reset(page)
  await ensureSidebar(page, true)
  await snap()
  await page.locator('input[placeholder^="Search sessions"]').first().fill('ci')
  await snap('search', { settle: 900 })
  await page.locator('input[placeholder^="Search sessions"]').first().fill('zzzz-no-such')
  await snap('search-empty', { settle: 900 })
  await page.locator('input[placeholder^="Search sessions"]').first().fill('')
})

S('sidebar-menus', 'sidebar', 'Sidebar: filter, row menu, footer actions', async ({ page, snap }) => {
  await reset(page)
  await ensureSidebar(page, true)
  // sessions filter / sort menu
  await page.locator('[data-slot=sidebar-wrapper] button:has(svg.lucide-list-filter), [data-slot=sidebar-wrapper] button[aria-label*="ilter"], [data-slot=sidebar-wrapper] button[aria-label*="ort"]').first().click({ timeout: T }).catch(() => {})
  await snap('filter-menu')
  await closeLayers(page)
  // row context menu (right click == long-press on touch)
  const row = await findSessionRow(page, 'Fix the failing CI pipeline')
  await row.click({ button: 'right', timeout: T })
  await snap('row-context-menu')
  await closeLayers(page)
  // footer actions
  for (const [i, el] of (await page.locator('[data-slot=sidebar-wrapper] footer button, [data-slot=sidebar-footer] button').all()).entries()) {
    await el.click({ timeout: 1500 }).catch(() => {})
    await snap(`footer-${i}`)
    await closeLayers(page)
  }
})

S('sidebar-bots', 'sidebar', 'Sidebar: Bots tab', async ({ page, snap }) => {
  await reset(page)
  await ensureSidebar(page, true)
  await clickText(page, 'Bots', { exact: true })
  await snap()
  await clickText(page, 'Sessions', { exact: true }).catch(() => {})
})

// --- transcripts -------------------------------------------------------------------------
S('session-markdown', 'chat', 'Markdown showcase (top / middle / bottom)', async ({ page, snap }) => {
  await reset(page)
  await ensureSidebar(page, false)
  await openSession(page, 'aud-md')
  await scrollThread(page, 'top')
  await snap('top')
  await scrollThread(page, 'mid')
  await snap('mid')
  await scrollThread(page, 'bottom')
  await snap('bottom')
})

S('session-i18n', 'chat', 'Non-Latin / RTL / emoji / unbroken strings', async ({ page, snap }) => {
  await reset(page)
  await ensureSidebar(page, false)
  await openSession(page, 'aud-i18n')
  await scrollThread(page, 'top')
  await snap('top')
  await scrollThread(page, 'bottom')
  await snap('bottom')
})

S('session-tools', 'chat', 'Tool cards (all kinds), collapsed then expanded', async ({ page, snap }) => {
  await reset(page)
  await ensureSidebar(page, false)
  await openSession(page, 'aud-tools', 3500)
  await scrollThread(page, 'top')
  await snap('collapsed-top')
  await scrollThread(page, 'mid')
  await snap('collapsed-mid')
  await expandToolCards(page)
  await scrollThread(page, 'top')
  await snap('expanded-top', { settle: 700 })
  await scrollThread(page, 'mid')
  await snap('expanded-mid')
  await scrollThread(page, 'bottom')
  await snap('expanded-bottom')
})

S('session-thinking', 'chat', 'Reasoning / thinking blocks', async ({ page, snap }) => {
  await reset(page)
  await ensureSidebar(page, false)
  await openSession(page, 'aud-think')
  await snap('collapsed')
  const t = page.getByText(/^(Thinking|Thought|Reasoning)/i).first()
  await t.click({ timeout: 1500 }).catch(() => {})
  await snap('expanded')
})

S('session-long', 'chat', 'Very long conversation: scrolling, jump-to-bottom', async ({ page, snap }) => {
  await reset(page)
  await ensureSidebar(page, false)
  await openSession(page, 'aud-long', 3200)
  await scrollThread(page, 'top')
  await snap('top')
  await scrollThread(page, 'mid')
  await snap('mid')
  await scrollThread(page, 'bottom')
  await snap('bottom')
})

S('session-title', 'chat', 'Extremely long title in tab strip / titlebar', async ({ page, snap }) => {
  await reset(page)
  await ensureSidebar(page, false)
  await openSession(page, 'aud-title')
  await snap()
})

S('session-edge', 'chat', 'Edge messages: giant tokens, empty reply, wide table', async ({ page, snap }) => {
  await reset(page)
  await ensureSidebar(page, false)
  await openSession(page, 'aud-edge')
  await scrollThread(page, 'top')
  await snap('top')
  await scrollThread(page, 'bottom')
  await snap('bottom')
})

S('message-actions', 'chat', 'Message action bars (copy / retry / branch ...) without hover', async ({ page, snap }) => {
  await reset(page)
  await ensureSidebar(page, false)
  await openSession(page, 'aud-md')
  await scrollThread(page, 'bottom')
  const msg = page.locator('[data-slot=message], [data-message-role], [data-role=assistant], [data-slot=assistant-message]').last()
  await msg.click({ timeout: 2000 }).catch(() => {})
  await snap('after-tap')
  await msg.click({ button: 'right', timeout: 2000 }).catch(() => {})
  await snap('context-menu')
})

// --- live turns (mock model) -------------------------------------------------------------
async function liveTurn(page, marker, wait) {
  await closeLayers(page)
  await ensureSidebar(page, false)
  await newChat(page)
  await typeInComposer(page, `${marker} audit run`)
  // plain Enter inserts a newline on touch devices (src/composer-touch.ts); Ctrl+Enter sends
  await page.keyboard.press('Control+Enter')
  await page.waitForTimeout(wait)
}

S('live-approval', 'chat', 'Approval prompt (dangerous command)', async ({ page, snap }) => {
  await liveTurn(page, '@@approval', 6000)
  await snap()
  await click(page, 'Always allow').catch(() => {})
  await snap('always-allow-menu')
  await reset(page)
  await click(page, 'Reject').catch(() => {})
}, { criticalIfFails: false })

S('live-clarify', 'chat', 'Clarify prompt with choices', async ({ page, snap }) => {
  await liveTurn(page, '@@clarify', 6000)
  await snap()
})

S('live-thinking-stream', 'chat', 'Streaming turn with reasoning', async ({ page, snap }) => {
  await liveTurn(page, '@@think', 3500)
  await snap('streaming')
  await page.waitForTimeout(9000)
  await snap('finished')
})

S('live-error', 'chat', 'Provider error: retry banner then final failure', async ({ page, snap }) => {
  await liveTurn(page, '@@error', 6000)
  await snap('retrying')
  await page.waitForTimeout(30000)
  await snap('failed')
})

S('live-busy-queue', 'chat', 'Composer while a turn is running (stop / queue)', async ({ page, snap }) => {
  await liveTurn(page, '@@slow', 2500)
  await typeInComposer(page, 'a queued follow-up message that is long enough to wrap onto a second line in the composer')
  await snap('typing-while-busy')
  await page.keyboard.press('Control+Enter')
  await snap('queued', { settle: 700 })
  await click(page, 'Stop').catch(() => {})
})

// --- composer ----------------------------------------------------------------------------
S('composer-states', 'composer', 'Composer: empty, multi-line, slash menu, @ mentions', async ({ page, snap }) => {
  await reset(page)
  await ensureSidebar(page, false)
  await newChat(page)
  await snap('empty')
  await typeInComposer(page, '/')
  await snap('slash-menu', { settle: 900 })
  await page.keyboard.type('mod')
  await snap('slash-filtered', { settle: 700 })
  await page.keyboard.press('Escape')
  const ed = await composer(page)
  await ed.fill('')
  await typeInComposer(page, '@')
  await snap('mention-menu', { settle: 900 })
  await page.keyboard.press('Escape')
  await ed.fill('')
  await typeInComposer(page, 'A long multi-line draft.\n'.repeat(1) + 'Line two of the draft that is long enough to wrap around on the narrow cover screen of a foldable.\nLine three\nLine four\nLine five\nLine six\nLine seven')
  await snap('multiline')
})

S('composer-attach-menu', 'composer', 'Composer: attach (+) menu, model, voice, dictation', async ({ page, snap }) => {
  await reset(page)
  await ensureSidebar(page, false)
  await openSession(page, 'aud-md')
  await click(page, 'Add context').catch(() => click(page, 'Add'))
  await snap('attach')
  await closeLayers(page)
  await click(page, /model/i).catch(async () => {
    await page.locator('[data-slot=composer-root] button:has-text("audit-model")').first().click({ timeout: 2000 })
  })
  await snap('model-menu', { settle: 900 })
  await closeLayers(page)
  await click(page, 'Voice chat engine')
  await snap('voice-engine')
  await closeLayers(page)
})

S('composer-keyboard', 'composer', 'Soft keyboard open: composer + thread remain usable', async ({ page, snap, vp }) => {
  await reset(page)
  await ensureSidebar(page, false)
  await openSession(page, 'aud-md')
  await typeInComposer(page, 'Typing with the soft keyboard open')
  const kb = Math.round(Math.min(vp.height * 0.42, 340))
  await page.setViewportSize({ width: vp.width, height: vp.height - kb })
  await page.waitForTimeout(600)
  const res = await snap('keyboard-open')
  const box = await page.evaluate(() => {
    const c = document.querySelector('[data-slot=composer-root]')
    const r = c?.getBoundingClientRect()
    const th = Array.from(document.querySelectorAll('*')).filter(e => e.scrollHeight > e.clientHeight + 40 && /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.clientHeight > 40).sort((a, b) => b.clientHeight - a.clientHeight)[0]
    return { composerBottom: r ? Math.round(r.bottom) : null, composerTop: r ? Math.round(r.top) : null, vh: innerHeight, threadH: th ? Math.round(th.clientHeight) : 0 }
  })
  if (box.composerBottom == null || box.composerBottom > box.vh + 1 || box.composerTop < 0) {
    res.findings.push({ rule: 'keyboard-composer-hidden', severity: 'high', selector: 'composer-root', text: '', rect: [0, box.composerTop ?? 0, 0, 0], detail: `composer spans ${box.composerTop}..${box.composerBottom} with viewport height ${box.vh}` })
  }
  if (box.threadH < 100) {
    res.findings.push({ rule: 'keyboard-thread-collapsed', severity: 'high', selector: 'thread', text: '', rect: [0, 0, 0, 0], detail: `thread scroll area only ${box.threadH}px tall while the keyboard is open` })
  }
  await page.setViewportSize({ width: vp.width, height: vp.height })
}, { reload: true })

// --- status bar / menus -------------------------------------------------------------------
S('statusbar-menus', 'shell', 'Status bar controls and their popovers', async ({ page, snap }) => {
  await reset(page)
  await ensureSidebar(page, false)
  await openSession(page, 'aud-md')
  await snap('bar')
  for (const name of ['Gateway', 'Smart', 'client v', 'backend v']) {
    await page.locator('[data-slot=statusbar]').getByRole('button', { name: new RegExp(name, 'i') }).first().click({ timeout: 2000 }).catch(() => {})
    await snap(`menu-${name.replace(/\W+/g, '')}`, { settle: 600 })
    await closeLayers(page)
  }
  // remaining unlabeled status buttons (cwd, usage, context)
  const n = await page.locator('[data-slot=statusbar] button').count()
  for (let i = 0; i < Math.min(n, 12); i++) {
    await page.locator('[data-slot=statusbar] button').nth(i).click({ timeout: 1500 }).catch(() => {})
    await snap(`btn-${i}`, { settle: 500 })
    await closeLayers(page)
  }
})

S('titlebar-controls', 'shell', 'Titlebar: tabs, new tab, right sidebar, session menu', async ({ page, snap }) => {
  await reset(page)
  await ensureSidebar(page, false)
  await openSession(page, 'aud-md')
  await snap('base')
  await click(page, 'Show right sidebar')
  await snap('right-sidebar', { settle: 900 })
  await click(page, 'Hide right sidebar').catch(() => {})
  await click(page, 'New session tab')
  await snap('new-tab')
  // tab context menu / session title dropdown
  await page.locator('[data-slot=pane-tab]').first().click({ button: 'right', timeout: 2000 }).catch(() => {})
  await snap('tab-context-menu')
  await closeLayers(page)
})

// --- settings (every page, discovered dynamically) --------------------------------------
S('settings', 'settings', 'Settings: every page and sub-page', async ({ page, snap }) => {
  await reset(page)
  await openSettings(page)
  await snap('open')
  const { layout, names } = await settingsItems(page)
  for (const name of names) {
    try {
      await gotoSettingsItem(page, layout, name)
      await snap(name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), { settle: 500, maxPerRule: 8 })
    } catch (e) {
      await snap(`${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}--unreachable`)
      throw new Error(`settings item "${name}": ${String(e.message).split('\n')[0]}`)
    }
  }
}, { criticalIfFails: true })

S('settings-search', 'settings', 'Settings search / command palette', async ({ page, snap }) => {
  await reset(page)
  await openSettings(page)
  await page.getByText('Search', { exact: false }).first().click({ timeout: T }).catch(() => {})
  await snap('search-open', { settle: 800 })
  await page.keyboard.type('font')
  await snap('search-results', { settle: 900 })
})

// --- pages ------------------------------------------------------------------------------
const PAGES = [
  ['command-center', '#/command-center'],
  ['capabilities', '#/capabilities'],
  ['messaging', '#/messaging'],
  ['webhooks', '#/webhooks'],
  ['artifacts', '#/artifacts'],
  ['cron', '#/cron'],
  ['profiles', '#/profiles'],
  ['agents', '#/agents'],
  ['starmap', '#/starmap'],
  ['session-import', '#/session-import']
]
for (const [id, hash] of PAGES) {
  S(`page-${id}`, 'pages', `Page ${hash}`, async ({ page, snap }) => {
    await closeLayers(page)
    await ensureSidebar(page, false)
    await go(page, hash, 2200)
    await snap('landing')
    // visit sub-navigation: tabs / nav items / dropdown items
    const tabs = await page.locator('[role=tab], [data-tour="overlay-nav"] button, [data-slot=tab-dropdown-trigger]').evaluateAll(es => es.map((e, i) => ({ i, t: (e.textContent || '').trim().slice(0, 30), vis: !!e.offsetParent })).filter(x => x.t && x.vis)).catch(() => [])
    const seen = new Set()
    for (const tb of tabs.slice(0, 12)) {
      if (seen.has(tb.t)) continue
      seen.add(tb.t)
      await page.locator('[role=tab], [data-tour="overlay-nav"] button, [data-slot=tab-dropdown-trigger]').filter({ hasText: tb.t }).first().click({ timeout: 1500 }).catch(() => {})
      await closeLayers(page)
      await snap(`tab-${tb.t.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, { settle: 700, maxPerRule: 8 })
    }
  })
}

// --- overlays ---------------------------------------------------------------------------
S('overlay-command-palette', 'overlays', 'Command palette (Ctrl+K equivalent)', async ({ page, snap }) => {
  await reset(page)
  await ensureSidebar(page, false)
  await newChat(page)
  await page.keyboard.press('Control+k')
  await snap('open', { settle: 900 })
  await page.keyboard.type('set')
  await snap('typed', { settle: 700 })
})

S('overlay-session-picker', 'overlays', 'Session switcher / picker', async ({ page, snap }) => {
  await reset(page)
  await ensureSidebar(page, false)
  await openSession(page, 'aud-md')
  await page.keyboard.press('Control+Tab').catch(() => {})
  await snap('ctrl-tab')
  await closeLayers(page)
  await page.keyboard.press('Control+o')
  await snap('ctrl-o')
})

S('onboarding', 'overlays', 'First-run onboarding / provider setup', async ({ page, snap }) => {
  // Removes the provider from the throwaway config, reloads, captures, then restores it.
  const cfg = path.join(HOME, 'config.yaml')
  const original = fs.readFileSync(cfg, 'utf8')
  try {
    fs.writeFileSync(cfg, 'onboarding:\n  seen:\n    profile_build_offered: true\n')
    await page.reload()
    await page.waitForTimeout(6000)
    await snap('welcome', { settle: 1200 })
    await page.getByText('Other providers').first().click({ timeout: 2500 }).catch(() => {})
    await snap('other-providers', { settle: 900 })
    await page.getByText('I have an API key').first().click({ timeout: 2500 }).catch(() => {})
    await snap('api-key', { settle: 900 })
  } finally {
    fs.writeFileSync(cfg, original)
  }
}, { exclusive: true, reload: true })

// --- dialogs / confirmations -------------------------------------------------------------
S('dialogs', 'dialogs', 'Rename / delete / archive confirmation dialogs', async ({ page, snap }) => {
  await reset(page)
  await ensureSidebar(page, true)
  const row = await findSessionRow(page, 'Fix the failing CI pipeline')
  await row.click({ button: 'right', timeout: T })
  const items = await page.locator('[role=menuitem]').allInnerTexts()
  for (const label of items.filter(t => /rename|delete|archive|branch|export|duplicate/i.test(t)).slice(0, 5)) {
    await row.click({ button: 'right', timeout: T }).catch(() => {})
    await page.getByRole('menuitem', { name: label }).first().click({ timeout: 2000 }).catch(() => {})
    await snap(`dialog-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, { settle: 700 })
    await closeLayers(page)
  }
})
