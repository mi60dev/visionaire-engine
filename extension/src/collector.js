/**
 * Visionaire "lite" page collector — the inspection backend for browsers whose
 * extensions get no DevTools Protocol (Firefox). Runs as a content script via
 * scripting.executeScript({ func: vzCollect, args: [cmd, args] }).
 *
 * MUST stay a single self-contained function: executeScript serializes `func`,
 * so no imports and no references to module scope. It is also injected into
 * pages by the Node test-suite (page.evaluate), so it must not touch extension
 * APIs. Returns plain JSON. Fixed command set — no code strings are ever
 * evaluated (Mozilla's no-remote-code policy).
 *
 * Commands: info | snapshot | find | inspect | hitTest | animations | sheetTexts
 */
export function vzCollect(cmd, args) {
  'use strict'
  args = args || {}

  // ── uid registry (persists in the content-script world until navigation) ──
  const g = globalThis
  if (!g.__vzState || g.__vzState.doc !== document) {
    g.__vzState = { doc: document, byUid: new Map(), byEl: new WeakMap(), next: 1 }
  }
  const S = g.__vzState
  function uidOf(el) {
    let u = S.byEl.get(el)
    if (!u) {
      u = 'f' + S.next++
      S.byEl.set(el, u)
      S.byUid.set(u, typeof WeakRef === 'function' ? new WeakRef(el) : { deref: () => el })
    }
    return u
  }
  function byUid(u) {
    const r = S.byUid.get(u)
    const el = r && r.deref()
    return el && el.isConnected ? el : null
  }
  const kind = (o) => Object.prototype.toString.call(o).slice(8, -1)
  const r1 = (n) => Math.round(n * 10) / 10
  const clip = (s, n) => {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
    return s.length > n ? s.slice(0, n - 1) + '…' : s
  }

  function describe(el) {
    if (!el || el.nodeType !== 1) return String(el)
    let s = el.tagName.toLowerCase()
    if (el.id) s += '#' + clip(el.id, 40)
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : []
    if (cls.length) s += '.' + cls.slice(0, 3).map((c) => clip(c, 40)).join('.') + (cls.length > 3 ? '…' : '')
    return s
  }
  function ownText(el, n) {
    let t = ''
    for (const c of el.childNodes) if (c.nodeType === 3) t += c.data
    t = t.trim()
    if (!t) t = el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('placeholder') || el.getAttribute('title') || ''
    if (!t && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.type !== 'password') t = el.value || ''
    return clip(t, n || 40)
  }
  function rectOf(el) {
    const r = el.getBoundingClientRect()
    return { x: r1(r.left), y: r1(r.top), w: r1(r.width), h: r1(r.height) }
  }
  function summary(el) {
    return { uid: uidOf(el), desc: describe(el), text: ownText(el, 60), rect: rectOf(el) }
  }

  const IMPLICIT_ROLE = {
    A: (el) => (el.hasAttribute('href') ? 'link' : ''),
    BUTTON: () => 'button', NAV: () => 'navigation', MAIN: () => 'main', HEADER: () => 'banner',
    FOOTER: () => 'contentinfo', ASIDE: () => 'complementary', FORM: () => 'form', DIALOG: () => 'dialog',
    IMG: () => 'img', UL: () => 'list', OL: () => 'list', LI: () => 'listitem', TABLE: () => 'table',
    SELECT: () => 'combobox', TEXTAREA: () => 'textbox', H1: () => 'heading', H2: () => 'heading',
    H3: () => 'heading', H4: () => 'heading', H5: () => 'heading', H6: () => 'heading',
    INPUT: (el) => ({ checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', range: 'slider', search: 'searchbox' })[el.type] || 'textbox',
  }
  const roleOf = (el) => el.getAttribute('role') || (IMPLICIT_ROLE[el.tagName] ? IMPLICIT_ROLE[el.tagName](el) : '')

  function resolve(t) {
    t = t || {}
    if (t.uid) {
      const el = byUid(t.uid)
      if (!el) throw new Error(`uid ${t.uid} is stale or unknown — take a fresh snapshot (uids reset on navigation)`)
      return el
    }
    if (t.selector) {
      let el
      try {
        el = document.querySelector(t.selector)
      } catch (e) {
        throw new Error(`invalid selector ${JSON.stringify(t.selector)}: ${e.message}`)
      }
      if (!el) {
        const words = String(t.selector).split(/[^a-zA-Z0-9_-]+/).filter((w) => w.length > 2).map((w) => w.toLowerCase())
        const near = new Set()
        for (const c of document.querySelectorAll('[id],[class]')) {
          const names = [c.id ? '#' + c.id : '', ...(typeof c.className === 'string' ? c.className.split(/\s+/).filter(Boolean).map((x) => '.' + x) : [])]
          for (const nm of names) if (nm && words.some((w) => nm.toLowerCase().includes(w))) near.add(nm)
          if (near.size >= 8) break
        }
        throw new Error(`selector ${JSON.stringify(t.selector)} matches nothing on ${location.href}` + (near.size ? ` — closest real names: ${[...near].join(' ')}` : ''))
      }
      return el
    }
    if (typeof t.x === 'number' && typeof t.y === 'number') {
      const el = document.elementFromPoint(t.x, t.y)
      if (!el) throw new Error(`nothing at (${t.x},${t.y}) — point is outside the viewport`)
      return el
    }
    throw new Error('provide a target: uid, selector, or x+y')
  }

  // ── info ──
  function info() {
    return {
      url: location.href,
      title: clip(document.title, 120),
      readyState: document.readyState,
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio, scrollX: r1(scrollX), scrollY: r1(scrollY) },
      document: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
      sheets: document.styleSheets.length,
      elements: document.getElementsByTagName('*').length,
    }
  }

  // ── snapshot: compact indented outline, uid-addressed ──
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE', 'BASE'])
  function snapshot() {
    const max = Math.min(Math.max(Number(args.maxNodes) || 250, 20), 2000)
    const root = args.root ? resolve(args.root) : document.body || document.documentElement
    const lines = []
    let hidden = 0
    let truncated = 0
    const walk = (el, depth) => {
      if (SKIP.has(el.tagName)) return
      const cs = getComputedStyle(el)
      if (cs.display === 'none') {
        hidden++
        return
      }
      if (lines.length >= max) {
        truncated++
        return
      }
      const r = el.getBoundingClientRect()
      const flags = []
      if (cs.visibility !== 'visible') flags.push('visibility:' + cs.visibility)
      if (cs.opacity === '0') flags.push('opacity:0')
      if (cs.position === 'fixed' || cs.position === 'sticky' || cs.position === 'absolute') flags.push(cs.position)
      if (cs.zIndex !== 'auto') {
        const pd = el.parentElement ? getComputedStyle(el.parentElement).display : ''
        // z-index on a static non-flex/grid item does nothing — a classic "z-index not working" cause.
        flags.push(cs.position === 'static' && !/flex|grid/.test(pd) ? `z-index:${cs.zIndex} IGNORED(position:static)` : 'z:' + cs.zIndex)
      }
      if (r.width === 0 || r.height === 0) flags.push('0-size')
      else if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) flags.push('offscreen')
      const role = el.getAttribute('role')
      const txt = ownText(el, 40)
      lines.push(
        ' '.repeat(Math.min(depth, 24)) +
          `[${uidOf(el)}] ${describe(el)}` +
          (role ? ` role=${clip(role, 20)}` : '') +
          (txt ? ` "${txt}"` : '') +
          ` ${Math.round(r.width)}×${Math.round(r.height)}@${Math.round(r.left)},${Math.round(r.top)}` +
          (flags.length ? ' {' + flags.join(' ') + '}' : ''),
      )
      if (el.tagName === 'svg' || el.tagName === 'SVG') return // collapse vector internals
      for (const c of el.children) walk(c, depth + 1)
      if (el.shadowRoot) for (const c of el.shadowRoot.children) walk(c, depth + 1)
    }
    walk(root, 0)
    return { info: info(), lines, hidden, truncated, max }
  }

  // ── find ──
  function find() {
    const limit = Math.min(Number(args.limit) || 10, 50)
    const q = args.text ? String(args.text).toLowerCase().trim() : ''
    const role = args.role ? String(args.role).toLowerCase() : ''
    let pool
    try {
      pool = args.selector ? [...document.querySelectorAll(args.selector)] : [...document.body.querySelectorAll('*')]
    } catch (e) {
      throw new Error(`invalid selector ${JSON.stringify(args.selector)}: ${e.message}`)
    }
    const out = []
    for (const el of pool) {
      if (SKIP.has(el.tagName)) continue
      if (role && roleOf(el) !== role) continue
      if (q) {
        const own = (ownText(el, 400) + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase()
        const full = (el.textContent || '').toLowerCase()
        if (!own.includes(q) && !(full.includes(q) && ![...el.children].some((c) => (c.textContent || '').toLowerCase().includes(q)))) continue
      }
      const s = summary(el)
      const cs = getComputedStyle(el)
      s.visible = cs.display !== 'none' && cs.visibility === 'visible' && s.rect.w > 0 && s.rect.h > 0
      s.role = roleOf(el)
      out.push(s)
      if (out.length >= limit) break
    }
    return { matches: out, info: info() }
  }

  // ── CSSOM cascade collection (synthetic CSS.getMatchedStylesForNode) ──
  function splitSelectors(text) {
    const out = []
    let depth = 0
    let cur = ''
    let quote = ''
    for (const ch of text) {
      if (quote) {
        cur += ch
        if (ch === quote) quote = ''
        continue
      }
      if (ch === '"' || ch === "'") quote = ch
      else if (ch === '(' || ch === '[') depth++
      else if (ch === ')' || ch === ']') depth--
      else if (ch === ',' && depth === 0) {
        out.push(cur.trim())
        cur = ''
        continue
      }
      cur += ch
    }
    if (cur.trim()) out.push(cur.trim())
    return out
  }
  function safeMatches(el, sel) {
    try {
      return el.matches(sel)
    } catch {
      return false // pseudo-elements, unsupported syntax
    }
  }
  const unreadable = new Set()
  let rulesCache = null
  function allStyleRules() {
    if (rulesCache) return rulesCache
    const out = []
    const sheets = [...document.styleSheets, ...(document.adoptedStyleSheets || [])]
    const walk = (container, si, path, media, layers) => {
      let rules
      try {
        rules = container.cssRules
      } catch {
        unreadable.add(sheets[si] && sheets[si].href ? sheets[si].href : 'sheet#' + si)
        return
      }
      if (!rules) return
      for (let i = 0; i < rules.length; i++) {
        const r = rules[i]
        const k = kind(r)
        const p = path.concat(i)
        if (k === 'CSSStyleRule') {
          out.push({ r, si, path: p, media, layers, selectors: splitSelectors(r.selectorText) })
        } else if (k === 'CSSMediaRule') {
          if (matchMedia(r.media.mediaText).matches) walk(r, si, p, media.concat(r.media.mediaText), layers)
        } else if (k === 'CSSSupportsRule') {
          if (CSS.supports(r.conditionText)) walk(r, si, p, media, layers)
        } else if (k === 'CSSLayerBlockRule') {
          walk(r, si, p, media, layers.concat(r.name || '(anonymous)'))
        } else if (k === 'CSSContainerRule') {
          walk(r, si, p, media.concat('@container ' + r.conditionText + ' (unverified)'), layers)
        } else if (k === 'CSSImportRule') {
          const mt = r.media && r.media.mediaText
          if (r.styleSheet && (!mt || matchMedia(mt).matches)) walk(r.styleSheet, si, p, mt ? media.concat(mt) : media, r.layerName != null ? layers.concat(r.layerName || '(anonymous)') : layers)
        }
      }
    }
    sheets.forEach((s, si) => {
      if (s.disabled) return
      const mt = s.media && s.media.mediaText
      if (mt && !matchMedia(mt).matches) return
      walk(s, si, [], mt ? [mt] : [], [])
    })
    rulesCache = { out, sheets }
    return rulesCache
  }

  const INHERITED = /^(color|font|font-.*|line-height|letter-spacing|word-spacing|text-align|text-indent|text-transform|text-shadow|white-space|visibility|cursor|list-style.*|direction|quotes|tab-size|word-break|overflow-wrap|hyphens|--.*)$/
  function declsOf(style, allow, inheritedOnly) {
    const props = []
    for (let i = 0; i < style.length; i++) {
      const name = style[i]
      if (allow && !allow.has(name) && !name.startsWith('--')) continue
      if (inheritedOnly && !INHERITED.test(name)) continue
      props.push({ name, value: style.getPropertyValue(name).trim(), important: style.getPropertyPriority(name) === 'important' })
    }
    return props
  }
  function matchedFor(el, allow, inheritedOnly, usedSheets) {
    const { out } = allStyleRules()
    const matches = []
    for (const e of out) {
      const idx = []
      e.selectors.forEach((s, i) => {
        if (safeMatches(el, s)) idx.push(i)
      })
      if (!idx.length) continue
      const props = declsOf(e.r.style, allow, inheritedOnly)
      if (!props.length) continue
      usedSheets.add(e.si)
      matches.push({
        rule: {
          selectorList: { selectors: e.selectors.map((text) => ({ text })), text: e.r.selectorText },
          origin: 'regular',
          styleSheetId: 'lite:' + e.si,
          style: { styleSheetId: 'lite:' + e.si, cssProperties: props, shorthandEntries: [] },
          media: e.media.map((text) => ({ text, source: 'mediaRule' })),
          layers: e.layers.slice().reverse().map((text) => ({ text })),
          vzRef: { sheet: e.si, path: e.path },
        },
        matchingSelectors: idx,
      })
    }
    const inline = el.style && el.style.length ? { cssProperties: declsOf(el.style, allow, inheritedOnly), shorthandEntries: [] } : undefined
    return { matches, inline }
  }

  const DEFAULT_PROPS = [
    'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'width', 'height', 'min-width', 'max-width',
    'min-height', 'max-height', 'box-sizing', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'color', 'background-color', 'background-image',
    'font-family', 'font-size', 'font-weight', 'line-height', 'text-align', 'opacity', 'visibility', 'overflow-x',
    'overflow-y', 'transform', 'pointer-events', 'flex-direction', 'justify-content', 'align-items', 'align-self',
    'flex-grow', 'flex-shrink', 'flex-basis', 'grid-template-columns', 'gap', 'transition-property',
    'transition-duration', 'animation-name', 'white-space', 'text-overflow',
  ]

  function stackingReason(el, cs) {
    if (el === document.documentElement) return 'root'
    if (cs.position !== 'static' && cs.zIndex !== 'auto') return `position:${cs.position} z-index:${cs.zIndex}`
    if (cs.position === 'fixed' || cs.position === 'sticky') return 'position:' + cs.position
    if (Number(cs.opacity) < 1) return 'opacity:' + cs.opacity
    if (cs.transform !== 'none') return 'transform'
    if (cs.filter !== 'none') return 'filter'
    if (cs.isolation === 'isolate') return 'isolation:isolate'
    if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') return 'mix-blend-mode'
    if (cs.willChange && /transform|opacity|filter/.test(cs.willChange)) return 'will-change'
    if (cs.contain && /paint|layout|strict|content/.test(cs.contain)) return 'contain'
    const p = el.parentElement && getComputedStyle(el.parentElement)
    if (p && /flex|grid/.test(p.display) && cs.zIndex !== 'auto') return 'flex/grid item z-index:' + cs.zIndex
    return ''
  }
  function stackingChain(el) {
    const chain = []
    for (let n = el; n && n.nodeType === 1 && chain.length < 6; n = n.parentElement) {
      const why = stackingReason(n, getComputedStyle(n))
      if (why) chain.push({ uid: uidOf(n), desc: describe(n), why })
    }
    return chain
  }

  function visibility(el) {
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    const causes = []
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const c = n === el ? cs : getComputedStyle(n)
      const who = n === el ? 'self' : `ancestor [${uidOf(n)}] ${describe(n)}`
      if (c.display === 'none') causes.push(`display:none on ${who}`)
      if (Number(c.opacity) === 0) causes.push(`opacity:0 on ${who}`)
      if (n === el && c.visibility !== 'visible') causes.push(`visibility:${c.visibility}`)
      if (c.contentVisibility === 'hidden') causes.push(`content-visibility:hidden on ${who}`)
    }
    if (r.width === 0 || r.height === 0) causes.push(`zero size (${r1(r.width)}×${r1(r.height)})`)
    if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) causes.push('outside the current viewport (scroll position ' + r1(scrollY) + ')')
    // clipped by an overflow ancestor
    for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      const c = getComputedStyle(n)
      if (c.overflowX === 'visible' && c.overflowY === 'visible' && c.clipPath === 'none') continue
      const pr = n.getBoundingClientRect()
      const visW = Math.min(r.right, pr.right) - Math.max(r.left, pr.left)
      const visH = Math.min(r.bottom, pr.bottom) - Math.max(r.top, pr.top)
      if (r.width > 0 && r.height > 0 && (visW < r.width - 1 || visH < r.height - 1)) {
        const pct = Math.max(0, Math.round((Math.max(0, visW) * Math.max(0, visH) * 100) / (r.width * r.height)))
        causes.push(`clipped by [${uidOf(n)}] ${describe(n)} (overflow ${c.overflowX}/${c.overflowY}${c.clipPath !== 'none' ? ', clip-path' : ''}) — ${pct}% visible`)
        break
      }
    }
    let coveredBy = null
    let hitStack = []
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    if (r.width > 0 && r.height > 0 && cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight) {
      const stack = document.elementsFromPoint(cx, cy)
      hitStack = stack.slice(0, 5).map((n) => {
        const c = getComputedStyle(n)
        return { uid: uidOf(n), desc: describe(n), position: c.position, zIndex: c.zIndex, pointerEvents: c.pointerEvents }
      })
      const top = stack[0]
      if (top && top !== el && !el.contains(top)) {
        coveredBy = { ...summary(top), stacking: stackingChain(top) }
        causes.push(`covered at its center by [${uidOf(top)}] ${describe(top)}`)
      }
    }
    if (cs.pointerEvents === 'none') causes.push('pointer-events:none (clicks pass through)')
    return { visible: causes.length === 0, causes, coveredBy, hitStack, stacking: stackingChain(el) }
  }

  function inspect() {
    const el = resolve(args.target)
    const cs = getComputedStyle(el)
    const allowList = Array.isArray(args.properties) && args.properties.length ? args.properties : null
    const allow = allowList ? new Set(allowList) : null
    const usedSheets = new Set()
    const own = matchedFor(el, allow, false, usedSheets)
    const inherited = []
    if (args.inherited !== false) {
      let depth = 0
      for (let n = el.parentElement; n && depth < 8; n = n.parentElement, depth++) {
        const m = matchedFor(n, allow, true, usedSheets)
        inherited.push({ matchedCSSRules: m.matches, inlineStyle: m.inline, uid: uidOf(n), desc: describe(n) })
      }
    }
    const computed = {}
    for (const p of allowList || DEFAULT_PROPS) computed[p] = cs.getPropertyValue(p)
    const { sheets } = allStyleRules()
    const sheetInfo = {}
    for (const si of usedSheets) {
      const s = sheets[si]
      const owner = s.ownerNode
      sheetInfo[si] = {
        href: s.href || null,
        inline: !s.href,
        owner: owner ? describe(owner) : 'adopted',
        ownerId: owner && owner.id ? owner.id : null,
      }
    }
    const parent = el.parentElement
    return {
      element: { ...summary(el), role: roleOf(el), attrs: [...el.attributes].slice(0, 12).map((a) => [a.name, clip(a.value, 80)]) },
      parent: parent ? { uid: uidOf(parent), desc: describe(parent), display: getComputedStyle(parent).display } : null,
      box: {
        margin: ['top', 'right', 'bottom', 'left'].map((s) => cs.getPropertyValue('margin-' + s)),
        border: ['top', 'right', 'bottom', 'left'].map((s) => cs.getPropertyValue('border-' + s + '-width')),
        padding: ['top', 'right', 'bottom', 'left'].map((s) => cs.getPropertyValue('padding-' + s)),
      },
      computed,
      matched: { matchedCSSRules: own.matches, inlineStyle: own.inline, inherited },
      inlineText: el.getAttribute('style') || '',
      sheets: sheetInfo,
      unreadableSheets: [...unreadable],
      visibility: visibility(el),
      info: info(),
    }
  }

  function hitTest() {
    const x = Number(args.x)
    const y = Number(args.y)
    const stack = document.elementsFromPoint(x, y).slice(0, Number(args.limit) || 8)
    return {
      x,
      y,
      stack: stack.map((n) => {
        const c = getComputedStyle(n)
        return { ...summary(n), position: c.position, zIndex: c.zIndex, opacity: c.opacity, pointerEvents: c.pointerEvents, stacking: stackingReason(n, c) }
      }),
    }
  }

  function animations() {
    const scope = args.target ? resolve(args.target) : null
    const list = scope ? scope.getAnimations({ subtree: true }) : document.getAnimations()
    return {
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      animations: list.slice(0, 40).map((a) => {
        const effect = a.effect
        const timing = effect && effect.getComputedTiming ? effect.getComputedTiming() : {}
        const target = effect && effect.target
        let props = []
        try {
          const kf = effect.getKeyframes()
          const set = new Set()
          for (const f of kf) for (const k of Object.keys(f)) if (!['offset', 'computedOffset', 'easing', 'composite'].includes(k)) set.add(k)
          props = [...set]
        } catch {
          // no keyframes
        }
        const k = kind(a)
        return {
          kind: k === 'CSSAnimation' ? 'CSSAnimation' : k === 'CSSTransition' ? 'CSSTransition' : 'WebAnimation',
          name: k === 'CSSAnimation' ? a.animationName : k === 'CSSTransition' ? a.transitionProperty : a.id || '',
          target: target ? { uid: uidOf(target), desc: describe(target) } : null,
          pseudo: effect && effect.pseudoElement ? effect.pseudoElement : null,
          playState: a.playState,
          currentTimeMs: a.currentTime == null ? null : Math.round(Number(a.currentTime)),
          durationMs: typeof timing.duration === 'number' ? timing.duration : 0,
          delayMs: timing.delay || 0,
          iterations: timing.iterations === Infinity ? 'infinite' : timing.iterations,
          easing: timing.easing || 'linear',
          fill: timing.fill || 'none',
          progress: timing.progress == null ? null : r1(timing.progress),
          properties: props.map((p) => p.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())),
        }
      }),
      total: list.length,
    }
  }

  function sheetTexts() {
    const sheets = [...document.styleSheets, ...(document.adoptedStyleSheets || [])]
    const out = {}
    for (const si of args.indexes || []) {
      const s = sheets[si]
      if (s && !s.href && s.ownerNode) out[si] = String(s.ownerNode.textContent || '').slice(0, 2_000_000)
    }
    return out
  }

  /** Every stylesheet URL the document loads, including @import chains (lite.fetch allowlist). */
  function sheetHrefs() {
    const out = new Set()
    const walk = (sheet) => {
      if (sheet.href) out.add(sheet.href)
      let rules
      try {
        rules = sheet.cssRules
      } catch {
        return
      }
      for (const r of rules) if (kind(r) === 'CSSImportRule' && r.styleSheet) walk(r.styleSheet)
    }
    for (const s of document.styleSheets) walk(s)
    return [...out]
  }

  switch (cmd) {
    case 'sheetHrefs':
      return sheetHrefs()
    case 'info':
      return info()
    case 'snapshot':
      return snapshot()
    case 'find':
      return find()
    case 'inspect':
      return inspect()
    case 'hitTest':
      return hitTest()
    case 'animations':
      return animations()
    case 'sheetTexts':
      return sheetTexts()
    default:
      throw new Error('unknown collector command: ' + cmd)
  }
}
