/**
 * Page-side checks. `pageChecks` is serialised by Playwright and evaluated inside the page,
 * so it must stay fully self-contained (no closures over module scope).
 *
 * It returns a list of findings: { rule, severity, selector, text, rect, detail }.
 * Rules (see REPORT.md for the human description):
 *   text-clipped, text-nowrap-clipped, text-collapsed, text-char-per-line,
 *   clipped-by-ancestor, offscreen, page-overflow-x, overlap, obscured,
 *   touch-target, hover-only, dialog-too-tall, dialog-offscreen, tiny-text,
 *   disclosure-collapsed, disclosure-clipped, disclosure-overlap (expanded tool groups / rows / thinking)
 */
export async function pageChecks(opts) {
  const findings = []
  const vw = window.innerWidth
  const vh = window.innerHeight
  const MAX_PER_RULE = opts.maxPerRule ?? 12

  const counts = {}
  const add = (rule, severity, el, detail, extra = {}) => {
    counts[rule] = (counts[rule] || 0) + 1
    if (counts[rule] > MAX_PER_RULE) return
    const r = el.getBoundingClientRect()
    findings.push({
      rule,
      severity,
      selector: describe(el),
      text: (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 80),
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      detail,
      ...extra
    })
  }

  function describe(el) {
    const parts = []
    let cur = el
    for (let i = 0; i < 4 && cur && cur.nodeType === 1 && cur !== document.body; i++) {
      let s = cur.tagName.toLowerCase()
      const slot = cur.getAttribute('data-slot')
      const role = cur.getAttribute('role')
      if (slot) s += `[data-slot=${slot}]`
      else if (role) s += `[role=${role}]`
      else if (cur.id) s += `#${cur.id}`
      else if (typeof cur.className === 'string' && cur.className.trim()) {
        const c = cur.className.trim().split(/\s+/).filter(x => !x.includes(':') && !x.includes('[')).slice(0, 2).join('.')
        if (c) s += `.${c}`
      }
      parts.unshift(s)
      cur = cur.parentElement
    }
    return parts.join(' > ')
  }

  const isVisible = el => {
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return false
    // visually-hidden (sr-only) helpers are 1px by design
    if (cs.position === 'absolute' && r.width <= 2 && r.height <= 2 && cs.overflow !== 'visible') return false
    return true
  }

  /** Effective opacity including ancestors. */
  const effOpacity = el => {
    let o = 1
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) o *= parseFloat(getComputedStyle(cur).opacity || '1')
    return o
  }

  const inert = el => !!el.closest('[inert], [aria-hidden="true"], template, [hidden]')

  /** Popovers, menus, dialogs and the narrow-mode slide-over sidebar legitimately cover what is behind them. */
  const LAYER = '[role=dialog], [role=alertdialog], [role=menu], [role=listbox], [data-radix-popper-content-wrapper], [data-slot=popover-content], [data-slot=dropdown-menu-content], [data-slot=context-menu-content], [data-slot=dialog-content], [data-slot=select-content], [data-slot=sheet-content], [data-overlay-surface], [data-slot=command], [cmdk-root], [data-slot=card-stack]'
  const layerOf = el => {
    const l = el.closest(LAYER)
    if (l) return l
    const slide = el.closest('[data-narrow-overlay], [data-slot=sidebar]')
    if (slide && vw < 640) return slide
    // full-viewport fixed scrim / modal surface (onboarding, update overlay, ...)
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      if (getComputedStyle(p).position === 'fixed') {
        const r = p.getBoundingClientRect()
        if (r.width >= vw * 0.9 && r.height >= vh * 0.9) return p
      }
    }
    return null
  }

  /** Nearest ancestor that actually scrolls vertically. */
  const scrollAncestor = el => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const c = getComputedStyle(p)
      if (/(auto|scroll)/.test(c.overflowY) && p.scrollHeight > p.clientHeight + 1) return p
    }
    return null
  }
  const isSticky = el => {
    for (let p = el; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).position === 'sticky') return true
    return false
  }

  const scrollableY = el => {
    const cs = getComputedStyle(el)
    return /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1
  }

  /** Visible rect of `el` after clipping by overflow:hidden|clip|auto|scroll ancestors and the viewport. */
  const clipRect = el => {
    const r = el.getBoundingClientRect()
    let left = r.left,
      top = r.top,
      right = r.right,
      bottom = r.bottom
    let clippedBy = null
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const cs = getComputedStyle(p)
      const pos = getComputedStyle(el).position
      // absolute/fixed descendants escape non-positioned ancestors; approximate by skipping when el is fixed.
      if (pos === 'fixed') break
      const ox = cs.overflowX
      const oy = cs.overflowY
      if (ox === 'visible' && oy === 'visible') continue
      const pr = p.getBoundingClientRect()
      const clipX = ox !== 'visible'
      const clipY = oy !== 'visible'
      const nl = clipX ? Math.max(left, pr.left) : left
      const nr = clipX ? Math.min(right, pr.right) : right
      const nt = clipY ? Math.max(top, pr.top) : top
      const nb = clipY ? Math.min(bottom, pr.bottom) : bottom
      if ((nl > left + 0.5 || nr < right - 0.5 || nt > top + 0.5 || nb < bottom - 0.5) && !clippedBy) {
        clippedBy = { el: p, hard: /(hidden|clip)/.test(ox + oy) && !/(auto|scroll)/.test(ox + oy), scroll: /(auto|scroll)/.test(ox + oy) }
      }
      left = nl
      right = nr
      top = nt
      bottom = nb
    }
    return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top), clippedBy }
  }

  // --- document level -----------------------------------------------------------------
  const de = document.documentElement
  if (de.scrollWidth > vw + 1 || document.body.scrollWidth > vw + 1) {
    add('page-overflow-x', 'high', de, `document scrollWidth ${Math.max(de.scrollWidth, document.body.scrollWidth)} > viewport ${vw}`)
  }

  const all = Array.from(document.querySelectorAll('body *')).filter(el => !['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName))
  const visible = all.filter(el => isVisible(el) && !inert(el))


  // --- expanded disclosures: content must have real height and must not overlap its siblings ------
  // (tool-run groups / tool rows are overflow-hidden boxes whose height is animated by JS; a stuck
  // animation leaves them a few px tall with their content clipped or painted over the text above)
  for (const g of document.querySelectorAll('[data-tool-group]')) {
    if (g.getAttribute('aria-hidden') === 'true' || !isVisible(g)) continue
    const rows = Array.from(g.querySelectorAll(':scope [data-tool-row]')).filter(r => r.getBoundingClientRect().height > 0 || r.scrollHeight > 0)
    const gr = g.getBoundingClientRect()
    if (rows.length && gr.height < 24) add('disclosure-collapsed', 'high', g, `expanded tool group is ${Math.round(gr.height)}px tall but holds ${rows.length} rows`)
    else if (g.scrollHeight > g.clientHeight + 8) add('disclosure-clipped', 'high', g, `tool group content ${g.scrollHeight}px is clipped to ${g.clientHeight}px`)
  }
  const rowEls = Array.from(document.querySelectorAll('[data-tool-row]')).filter(r => isVisible(r) && !inert(r))
  for (const r of rowEls) {
    const rr = r.getBoundingClientRect()
    if (r.hasAttribute('data-tool-open') && rr.height < 40) add('disclosure-collapsed', 'high', r, `expanded tool row is only ${Math.round(rr.height)}px tall`)
    else if (r.scrollHeight > r.clientHeight + 10) add('disclosure-clipped', 'medium', r, `tool row content ${r.scrollHeight}px is clipped to ${r.clientHeight}px`)
    if (rr.height > 0 && rr.height < 14) add('disclosure-collapsed', 'high', r, `tool row squeezed to ${Math.round(rr.height)}px`)
  }
  for (let i = 0; i < rowEls.length; i++) {
    for (let j = i + 1; j < Math.min(rowEls.length, i + 6); j++) {
      if (rowEls[i].contains(rowEls[j]) || rowEls[j].contains(rowEls[i])) continue
      const a = rowEls[i].getBoundingClientRect()
      const b = rowEls[j].getBoundingClientRect()
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left)
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
      if (ox > 8 && oy > 4 && a.height > 0 && b.height > 0) add('disclosure-overlap', 'high', rowEls[j], `overlaps the previous tool row by ${Math.round(oy)}px`)
    }
  }
  // thinking / reasoning disclosure: an open one must show its text, and the text must not run under the next sibling
  for (const btn of document.querySelectorAll('[data-slot=aui_assistant-message-root] button[aria-expanded=true]')) {
    if (!isVisible(btn) || btn.closest('[data-tool-row]')) continue
    const host = btn.closest('[data-slot=aui_reasoning], [data-slot*=reasoning], [data-slot=aui_assistant-message-content] > *') || btn.parentElement?.parentElement
    const next = host && host.nextElementSibling
    if (host && next && isVisible(next)) {
      const a = host.getBoundingClientRect()
      const b = next.getBoundingClientRect()
      if (b.height > 0 && a.bottom - b.top > 6 && a.height > 0) add('disclosure-overlap', 'high', next, `overlaps the expanded disclosure above by ${Math.round(a.bottom - b.top)}px`)
    }
  }

  // --- text fit with pretext -------------------------------------------------------------
  let pt = null
  try {
    pt = await import(opts.pretextUrl)
    if (document.fonts && document.fonts.ready) await document.fonts.ready
  } catch (e) {
    findings.push({ rule: 'audit-error', severity: 'info', selector: 'pretext', text: '', rect: [0, 0, 0, 0], detail: `pretext import failed: ${e.message}` })
  }

  const mismatch = { checked: 0, lineCountDiffers: 0 }

  const ownText = el => {
    // all-inline children -> use innerText of the whole element; otherwise own text nodes only
    const kids = Array.from(el.children)
    const inlineOnly = kids.every(k => /^inline/.test(getComputedStyle(k).display) && !/(SVG|IMG|BUTTON|INPUT|TEXTAREA|SELECT)/i.test(k.tagName))
    const hasText = Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim())
    if (!hasText) return null
    if (inlineOnly) return (el.innerText || '').replace(/​/g, '')
    return Array.from(el.childNodes)
      .filter(n => n.nodeType === 3)
      .map(n => n.textContent)
      .join(' ')
  }

  const fontOf = cs => `${cs.fontStyle === 'normal' ? '' : cs.fontStyle + ' '}${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`

  const actualLines = el => {
    const range = document.createRange()
    range.selectNodeContents(el)
    const tops = new Set()
    for (const rc of range.getClientRects()) if (rc.width > 0 && rc.height > 0) tops.add(Math.round(rc.top / 3))
    return tops.size
  }

  for (const el of visible) {
    const cs = getComputedStyle(el)
    if (/^inline/.test(cs.display) && cs.display !== 'inline-block' && cs.display !== 'inline-flex') continue
    if (['INPUT', 'TEXTAREA', 'SELECT', 'SVG', 'svg', 'CANVAS', 'PRE', 'CODE'].includes(el.tagName) && el.tagName !== 'CODE') continue
    // rotated labels (collapsed pane rails) are laid out vertically: width/height logic does not apply
    if (/^(vertical|sideways)/.test(cs.writingMode)) continue
    const raw = ownText(el)
    if (!raw) continue
    let text = raw
    if (cs.textTransform === 'uppercase') text = text.toUpperCase()
    else if (cs.textTransform === 'lowercase') text = text.toLowerCase()
    const compact = text.replace(/\s+/g, ' ').trim()
    if (!compact) continue

    const fs = parseFloat(cs.fontSize)
    const lh = cs.lineHeight === 'normal' ? fs * 1.25 : parseFloat(cs.lineHeight)
    const padL = parseFloat(cs.paddingLeft) || 0,
      padR = parseFloat(cs.paddingRight) || 0,
      padT = parseFloat(cs.paddingTop) || 0,
      padB = parseFloat(cs.paddingBottom) || 0
    const bL = parseFloat(cs.borderLeftWidth) || 0,
      bR = parseFloat(cs.borderRightWidth) || 0
    const contentW = el.clientWidth - padL - padR
    const contentH = el.clientHeight - padT - padB
    const nowrap = /nowrap|pre$/.test(cs.whiteSpace) && cs.whiteSpace !== 'pre-wrap' && cs.whiteSpace !== 'pre-line'
    const ellipsis = cs.textOverflow === 'ellipsis'
    const lineClamp = cs.webkitLineClamp && cs.webkitLineClamp !== 'none'
    const hardClip = /(hidden|clip)/.test(cs.overflowX) || /(hidden|clip)/.test(cs.overflowY)
    const vis = clipRect(el)

    // (1) collapsed: container narrower than ~2 average glyphs while it holds a lot of text
    const avgChar = fs * 0.5
    const r0 = el.getBoundingClientRect()
    if (contentW < avgChar * 2 && compact.length >= 3 && r0.height > 0) {
      add('text-collapsed', 'high', el, `content width ${Math.round(contentW)}px (< 2 chars of ${fs}px text) holding ${compact.length} chars`)
      continue
    }

    if (!pt || contentW <= 0) continue
    let prepared
    try {
      const ws = cs.whiteSpace.startsWith('pre') ? 'pre-wrap' : 'normal'
      const ls = cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing) || 0
      prepared = pt.prepareWithSegments(ws === 'pre-wrap' ? text : compact, fontOf(cs), { whiteSpace: ws, letterSpacing: ls, wordBreak: cs.wordBreak === 'keep-all' ? 'keep-all' : 'normal' })
    } catch (e) {
      continue
    }
    mismatch.checked++
    const natural = nowrap ? pt.measureNaturalWidth(prepared) : 0
    const lay = pt.layout(prepared, Math.max(1, contentW), lh)
    const need = lay.height
    const expectedLines = lay.lineCount
    const actual = actualLines(el)
    if (nowrap ? false : actual && expectedLines !== actual) mismatch.lineCountDiffers++

    // (2) clipped height: needs more height than the box while clipping
    if (!nowrap && !lineClamp && /(hidden|clip)/.test(cs.overflowY) && contentH > 0 && need > contentH + lh * 0.6 && !ellipsis) {
      add('text-clipped', 'high', el, `needs ${Math.round(need)}px (${expectedLines} lines) but box content height is ${Math.round(contentH)}px with overflow ${cs.overflowY}`, { needHeight: Math.round(need), boxHeight: Math.round(contentH) })
    }
    // (2b) fixed-height box where actual scrollHeight exceeds the box and is clipped
    else if (!lineClamp && /(hidden|clip)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 2 && !ellipsis && el.clientHeight > 0 && !nowrap) {
      add('text-clipped', 'high', el, `scrollHeight ${el.scrollHeight} > clientHeight ${el.clientHeight} with overflow-y ${cs.overflowY}`)
    }

    // (3) nowrap: natural width exceeding the box
    const faded = (() => {
      for (let p = el, i = 0; p && i < 4; p = p.parentElement, i++) {
        const c = getComputedStyle(p)
        if ((c.maskImage && c.maskImage !== 'none') || (c.webkitMaskImage && c.webkitMaskImage !== 'none')) return true
      }
      return false
    })()
    if (nowrap && contentW > 0 && natural > contentW + 1 && !faded) {
      if (hardClip && !ellipsis) add('text-nowrap-clipped', 'high', el, `nowrap text needs ${Math.round(natural)}px but box is ${Math.round(contentW)}px and clips without ellipsis`)
      else if (hardClip && ellipsis) {
        const shown = Math.floor((contentW / natural) * compact.length)
        if (shown < 4 && compact.length > 6) add('text-collapsed', 'medium', el, `ellipsis shows only ~${shown} of ${compact.length} chars (box ${Math.round(contentW)}px, text ${Math.round(natural)}px)`)
      } else if (!hardClip) {
        // overflows visibly: fine inside, bad when it leaves the viewport (handled by offscreen rule)
      }
    }

    // (4) char-per-line breakdown
    if (!nowrap && expectedLines >= 3 && compact.length >= 10) {
      const cpl = compact.length / expectedLines
      if (cpl < 3 && !/\s{0}[A-Za-zÀ-ɏ]{25,}/.test(compact)) {
        add('text-char-per-line', 'high', el, `${compact.length} chars flow over ${expectedLines} lines (${cpl.toFixed(1)} chars/line) at content width ${Math.round(contentW)}px`)
      }
    }

    // (5) text visibly cut by a hard-clipping ancestor (not by a scroll container)
    const rr = el.getBoundingClientRect()
    if (vis.clippedBy && vis.clippedBy.hard) {
      const area = rr.width * rr.height
      const visArea = vis.width * vis.height
      if (area > 0 && visArea < area * 0.9 && vis.width > 0 && vis.height > 0) {
        add('clipped-by-ancestor', 'high', el, `only ${Math.round((visArea / area) * 100)}% visible: clipped by ${describe(vis.clippedBy.el)}`)
      }
    }

    // (6) text that sits (partly) outside the viewport and cannot be scrolled to
    if (rr.width > 0 && (rr.right > vw + 1.5 || rr.left < -1.5)) {
      let scrollX = false
      for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
        const c = getComputedStyle(p)
        if (/(auto|scroll)/.test(c.overflowX) && p.scrollWidth > p.clientWidth + 1) scrollX = true
      }
      if (!scrollX && getComputedStyle(el).position !== 'fixed' && effOpacity(el) > 0.1) add('offscreen', 'high', el, `text box ${Math.round(rr.left)}..${Math.round(rr.right)} extends outside viewport 0..${vw}`)
    }

    if (fs < 10 && effOpacity(el) > 0.3) add('tiny-text', 'low', el, `font-size ${fs}px`)
  }

  // --- viewport containment -----------------------------------------------------------
  const flaggedOff = new Set()
  for (const el of visible) {
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) continue
    if (effOpacity(el) < 0.05) continue
    const cs = getComputedStyle(el)
    // skip children of already flagged elements
    let skip = false
    for (let p = el.parentElement; p; p = p.parentElement) if (flaggedOff.has(p)) skip = true
    if (skip) continue
    const vis = clipRect(el)
    // fully clipped by an ancestor (hidden by overflow) and not scrollable -> not rendered, skip
    if (vis.width < 1 || vis.height < 1) continue
    const rightOut = vis.right > vw + 1,
      leftOut = vis.left < -1
    if (rightOut || leftOut) {
      const isText = Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim())
      const interactive = el.matches('button, a[href], input, select, textarea, [role=button], [role=menuitem], [role=tab], [role=switch], [role=checkbox], [role=option]')
      if (isText || interactive || el.matches('[role=dialog], [role=menu], [role=listbox], [data-radix-popper-content-wrapper] > *')) {
        add('offscreen', interactive ? 'high' : 'medium', el, `visible box ${Math.round(vis.left)}..${Math.round(vis.right)} outside viewport 0..${vw}`)
        flaggedOff.add(el)
      }
    }
  }

  // --- interactive elements: obscured / touch target / overlap / hover-only -------------
  const INTERACTIVE = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=tab], [role=switch], [role=checkbox], [role=radio], [role=option], [role=combobox], [role=slider], summary'
  const modal = Array.from(document.querySelectorAll('[role=dialog][data-state=open], [role=alertdialog], [aria-modal=true]')).filter(isVisible).pop()
  // `pointer-events: none` controls (e.g. the rows of the live one-line tool ticker) cannot be tapped: not touch targets
  const interactive = visible.filter(el => el.matches(INTERACTIVE) && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && getComputedStyle(el).pointerEvents !== 'none')
  const scope = modal ? interactive.filter(el => modal.contains(el)) : interactive

  const hitExtent = el => {
    // effective hit area incl. ::after/::before expansion: probe outwards from the centre
    const r = el.getBoundingClientRect()
    const cx = Math.min(Math.max(r.left + r.width / 2, 0), vw - 1)
    const cy = Math.min(Math.max(r.top + r.height / 2, 0), vh - 1)
    const hits = (x, y) => {
      if (x < 0 || y < 0 || x >= vw || y >= vh) return false
      const t = document.elementFromPoint(x, y)
      return !!t && (t === el || el.contains(t))
    }
    const ext = (dx, dy, limit) => {
      let n = 0
      for (let s = 1; s <= limit; s += 1) {
        if (hits(cx + dx * s, cy + dy * s)) n = s
        else if (s > n + 3) break
      }
      return n
    }
    const lim = 34
    const w = ext(-1, 0, lim) + ext(1, 0, lim) + 1
    const h = ext(0, -1, lim) + ext(0, 1, lim) + 1
    return { w, h, centerHit: hits(cx, cy) }
  }

  const rects = []
  for (const el of scope) {
    const r = el.getBoundingClientRect()
    if (effOpacity(el) < 0.05) {
      // hover-only: a control that exists but is fully transparent until hover
      if (r.width >= 8 && r.height >= 8 && !el.closest('[data-state=closed]')) add('hover-only', 'medium', el, 'interactive element is fully transparent (revealed only on hover, which touch screens do not have)')
      continue
    }
    const vis = clipRect(el)
    if (vis.width < 2 || vis.height < 2) continue
    // off-screen vertically inside a scroll area: reachable by scrolling, skip
    if (vis.bottom < 0 || vis.top > vh || vis.right < 0 || vis.left > vw) continue
    // a control wrapped in a <label> with text (switch + caption) is toggled by tapping the label
    const labelHost = el.closest('label')
    const ext = hitExtent(el)
    if (labelHost && labelHost.innerText.trim()) {
      const lr = labelHost.getBoundingClientRect()
      ext.w = Math.max(ext.w, lr.width)
      ext.h = Math.max(ext.h, lr.height)
    }
    const clippedVisRatio = (vis.width * vis.height) / Math.max(1, r.width * r.height)
    if (!ext.centerHit && clippedVisRatio > 0.5) {
      const cx = Math.min(Math.max(r.left + r.width / 2, 0), vw - 1)
      const cy = Math.min(Math.max(r.top + r.height / 2, 0), vh - 1)
      const top = document.elementFromPoint(cx, cy)
      // Radix "pointer-events:none" while a layer is open and transitions can legitimately hide; only flag stable states
      const coverLayer = top && layerOf(top)
      // content scrolled under fixed chrome (titlebar, composer dock) is reachable by scrolling
      const sc = scrollAncestor(el)
      const scrolledUnderChrome = (sc && top && !sc.contains(top)) || (top && isSticky(top))
      if (top && !top.contains(el) && !el.contains(top) && !(coverLayer && !coverLayer.contains(el)) && !scrolledUnderChrome) {
        add('obscured', 'high', el, `centre point is covered by ${describe(top)}`)
      }
    }
    const minDim = Math.min(Math.max(r.width, ext.w), Math.max(r.height, ext.h))
    const bare = /^(INPUT|TEXTAREA)$/.test(el.tagName) && (el.type === 'text' || el.tagName === 'TEXTAREA' || el.type === 'search' || el.type === 'password' || el.type === 'url' || el.type === 'email' || el.type === 'number')
    const effW = Math.max(r.width, ext.w)
    const effH = Math.max(r.height, ext.h)
    // links / buttons inside running prose are exempt (WCAG 2.5.8 inline exception)
    const inlineLink = (el.tagName === 'A' && getComputedStyle(el).display === 'inline') || el.matches('a.ref, button.ref')
    if (!inlineLink && (effW < 44 || effH < 44) && !(bare && effH >= 32)) {
      const m = Math.min(effW, effH)
      // WCAG 2.5.8 minimum target is 24px; Material/Apple recommend 44-48px
      const sev = m < 24 ? 'medium' : 'low'
      add('touch-target', sev, el, `effective hit area ${Math.round(effW)}x${Math.round(effH)}px (< 44) [visual ${Math.round(r.width)}x${Math.round(r.height)}]`)
    }
    rects.push({ el, r: { left: vis.left, top: vis.top, right: vis.right, bottom: vis.bottom }, ext })
  }

  // overlapping interactive elements (neither contains the other)
  const overlapSeen = new Set()
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i],
        b = rects[j]
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue
      const ix = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left)
      const iy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top)
      if (ix <= 2 || iy <= 2) continue
      const areaA = (a.r.right - a.r.left) * (a.r.bottom - a.r.top)
      const areaB = (b.r.right - b.r.left) * (b.r.bottom - b.r.top)
      const frac = (ix * iy) / Math.max(1, Math.min(areaA, areaB))
      const big = Math.max(areaA, areaB)
      const small = Math.min(areaA, areaB)
      // a small control fully inside a bigger one (chevron on a nav row, remove-x on a chip) is a deliberate affordance
      if (frac >= 0.98 && small < big * 0.3) continue
      if (frac > 0.3) {
        // ignore label+input, same-component groups that share a parent <label>
        if (a.el.closest('label') && a.el.closest('label') === b.el.closest('label')) continue
        if (layerOf(a.el) !== layerOf(b.el)) continue
        // transcript content passing under fixed chrome / sticky headers is by design
        if (scrollAncestor(a.el) !== scrollAncestor(b.el)) continue
        if (isSticky(a.el) || isSticky(b.el)) continue
        const key = describe(a.el) + '|' + describe(b.el)
        if (overlapSeen.has(key)) continue
        overlapSeen.add(key)
        add('overlap', 'high', a.el, `overlaps ${describe(b.el)} (${Math.round(frac * 100)}% of the smaller)`, { other: describe(b.el), otherText: (b.el.innerText || b.el.getAttribute('aria-label') || '').trim().slice(0, 40) })
      }
    }
  }

  // --- dialogs / popovers ---------------------------------------------------------------
  const layers = Array.from(document.querySelectorAll('[role=dialog], [role=alertdialog], [role=menu], [role=listbox], [data-slot=popover-content], [data-slot=dropdown-menu-content], [data-slot=dialog-content], [data-slot=select-content]')).filter(el => isVisible(el) && !inert(el) && effOpacity(el) > 0.5 && !el.closest('[data-state=closed]'))
  for (const d of layers) {
    const r = d.getBoundingClientRect()
    if (r.width < 20 || r.height < 20) continue
    if (r.bottom < 0 || r.top > vh) continue // parked outside the viewport (measuring / closed)
    if (r.left < -1 || r.right > vw + 1) add('dialog-offscreen', 'high', d, `layer spans ${Math.round(r.left)}..${Math.round(r.right)} of viewport width ${vw}`)
    if (r.height > vh + 1 || r.top < -1 || r.bottom > vh + 1) {
      const scroller = [d, ...d.querySelectorAll('*')].some(scrollableY)
      if (!scroller) add('dialog-too-tall', 'high', d, `layer spans ${Math.round(r.top)}..${Math.round(r.bottom)} of viewport height ${vh} and has no scrollable region`)
      else if (r.top < -1 || r.bottom > vh + 40) add('dialog-too-tall', 'medium', d, `layer extends outside the viewport (${Math.round(r.top)}..${Math.round(r.bottom)} of ${vh}) although it has a scroll region`)
    }
  }

  return { findings, counts, mismatch, viewport: { vw, vh } }
}
