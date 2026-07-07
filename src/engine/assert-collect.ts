/**
 * Evidence collector for assert_visual (v-next SPEC §3A) — resolves assertion
 * targets (uid | selector = ALL matches | role+name) and gathers the measured
 * facts the pure grammar in assert.ts evaluates: content/border boxes, the
 * computed subset, clipping ancestors, paint order, text metrics, painted
 * background samples.
 *
 * Coordinate space: DOCUMENT CSS px throughout (getBoundingClientRect +
 * scroll offset, matching DOMSnapshot layout bounds), so assertions are stable
 * across scroll positions. One Runtime.callFunctionOn per element; DOMSnapshot
 * and the screenshot are captured lazily, at most once per runAssertions call.
 */
import type { Protocol } from 'puppeteer-core'
import type { Bounds, ResolvedNode, ToolContext } from '../types.js'
import { pairAttributes, resolveTarget } from '../uid.js'
import { decodePng, type DecodedPng } from './png.js'
import { parseCssColor, type Rgba } from './color.js'
import {
  evaluateAssertion,
  type AssertionEvidence,
  type AssertionResult,
  type AssertionSpec,
  type AssertTargetSpec,
  type MeasuredElement,
  type TextEvidence,
  DEFAULT_TOLERANCE_PX,
  isAssertionType,
  ARITY,
} from './assert.js'

const OBJECT_GROUP = 'visionaire-assert'
/** Selector / role targets resolve at most this many elements (matches check_alignment's cap). */
const MAX_TARGETS = 40

// ───────────────────────── Page-level facts ─────────────────────────

interface PageFacts {
  scrollX: number
  scrollY: number
  viewport: Bounds // document coords of the visual viewport
  dpr: number
}

async function pageFacts(ctx: ToolContext): Promise<PageFacts> {
  // Layout viewport (documentElement.clientWidth/Height) — innerWidth includes
  // classic scrollbars, which would skew centered/within_viewport by ~15px on
  // Windows/Linux headful Chrome. Falls back to innerWidth when 0/absent.
  const res = await ctx.cdp.send('Runtime.evaluate', {
    expression:
      '({ sx: window.scrollX, sy: window.scrollY, ' +
      'w: (document.documentElement && document.documentElement.clientWidth) || window.innerWidth, ' +
      'h: (document.documentElement && document.documentElement.clientHeight) || window.innerHeight, ' +
      'dpr: window.devicePixelRatio })',
    returnByValue: true,
  })
  const v = (res.result.value ?? {}) as { sx?: number; sy?: number; w?: number; h?: number; dpr?: number }
  const sx = v.sx ?? 0
  const sy = v.sy ?? 0
  return {
    scrollX: sx,
    scrollY: sy,
    viewport: { x: sx, y: sy, width: v.w ?? 0, height: v.h ?? 0 },
    dpr: v.dpr && v.dpr > 0 ? v.dpr : 1,
  }
}

// ───────────────────────── Target resolution ─────────────────────────

/**
 * A dead/detached browser session must surface as a TOOL error (connect again),
 * never be miscoded as a per-assertion TARGET_NOT_FOUND — 49 bogus ERRORs on a
 * 50-assertion suite would read as "my selectors are wrong".
 */
function isSessionDeath(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /session closed|target closed|connection closed|browser has disconnected|websocket is not open|protocol error.*detached/i.test(
    msg,
  )
}

/** Typed resolution failure — becomes a per-assertion ERROR, not a thrown tool error. */
export class TargetResolutionError extends Error {
  constructor(
    public code: 'TARGET_NOT_FOUND' | 'TARGET_AMBIGUOUS',
    message: string,
  ) {
    super(message)
  }
}

async function describeAndAssign(ctx: ToolContext, nodeId: Protocol.DOM.NodeId): Promise<ResolvedNode> {
  const described = (await ctx.cdp.send('DOM.describeNode', { nodeId })) as Protocol.DOM.DescribeNodeResponse
  const attrs = pairAttributes(described.node.attributes)
  const uid = ctx.uids.assign(described.node.backendNodeId, {
    tag: described.node.nodeName.toLowerCase(),
    classes: (attrs.get('class') ?? '').split(/\s+/).filter(Boolean),
    attrId: attrs.get('id'),
  })
  return { uid, backendNodeId: described.node.backendNodeId, nodeId }
}

async function resolveSelectorAll(ctx: ToolContext, selector: string): Promise<ResolvedNode[]> {
  const doc = (await ctx.cdp.send('DOM.getDocument', { depth: 0 })) as Protocol.DOM.GetDocumentResponse
  let res: Protocol.DOM.QuerySelectorAllResponse
  try {
    res = (await ctx.cdp.send('DOM.querySelectorAll', {
      nodeId: doc.root.nodeId,
      selector,
    })) as Protocol.DOM.QuerySelectorAllResponse
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // CDP rejects malformed selectors with a syntax error; anything else (stale
    // node ids, detaching session) must surface as-is, not masquerade as one.
    if (/syntax|selector/i.test(msg)) throw new Error(`Invalid CSS selector: ${selector}`)
    throw new Error(`selector "${selector}" could not be queried: ${msg}`)
  }
  if (res.nodeIds.length > MAX_TARGETS) {
    // Fail loud rather than silently measuring a subset — a truncated element
    // set can flip an equal_height/aligned_edges verdict to a false PASS.
    throw new TargetResolutionError(
      'TARGET_AMBIGUOUS',
      `selector "${selector}" matches ${res.nodeIds.length} elements — the cap is ${MAX_TARGETS}; narrow the selector`,
    )
  }
  const out: ResolvedNode[] = []
  for (const nodeId of res.nodeIds) {
    out.push(await describeAndAssign(ctx, nodeId))
  }
  return out
}

async function resolveRole(ctx: ToolContext, role: string, name?: string): Promise<ResolvedNode[]> {
  const doc = (await ctx.cdp.send('DOM.getDocument', { depth: 0 })) as Protocol.DOM.GetDocumentResponse
  await ctx.cdp.send('Accessibility.enable').catch(() => {})
  const params: Record<string, unknown> = { backendNodeId: doc.root.backendNodeId, role }
  if (name !== undefined) params['accessibleName'] = name
  const res = (await ctx.cdp.send(
    'Accessibility.queryAXTree',
    params,
  )) as Protocol.Accessibility.QueryAXTreeResponse
  const eligible = res.nodes.filter((ax) => !ax.ignored && ax.backendDOMNodeId !== undefined)
  if (eligible.length > MAX_TARGETS) {
    throw new TargetResolutionError(
      'TARGET_AMBIGUOUS',
      `role "${role}"${name !== undefined ? ` name "${name}"` : ''} matches ${eligible.length} elements — the cap is ${MAX_TARGETS}; add a name or narrow the query`,
    )
  }
  const out: ResolvedNode[] = []
  for (const ax of eligible) {
    const pushed = (await ctx.cdp.send('DOM.pushNodesByBackendIdsToFrontend', {
      backendNodeIds: [ax.backendDOMNodeId!],
    })) as Protocol.DOM.PushNodesByBackendIdsToFrontendResponse
    const nodeId = pushed.nodeIds[0]
    if (!nodeId) continue
    out.push(await describeAndAssign(ctx, nodeId))
  }
  return out
}

/** Resolve one target spec entry to its element(s). Selector/role entries expand to ALL matches. */
export async function resolveAssertTarget(ctx: ToolContext, t: AssertTargetSpec): Promise<ResolvedNode[]> {
  if (typeof t === 'string') return [await resolveTarget(ctx, { uid: t })]
  if ('selector' in t && typeof t.selector === 'string') {
    const nodes = await resolveSelectorAll(ctx, t.selector)
    if (nodes.length === 0) {
      throw new TargetResolutionError('TARGET_NOT_FOUND', `selector "${t.selector}" matches 0 elements (resolved_count: 0)`)
    }
    return nodes
  }
  if ('role' in t && typeof t.role === 'string') {
    const nodes = await resolveRole(ctx, t.role, t.name)
    if (nodes.length === 0) {
      const label = t.name !== undefined ? `role "${t.role}" name "${t.name}"` : `role "${t.role}"`
      throw new TargetResolutionError('TARGET_NOT_FOUND', `${label} matches 0 elements (resolved_count: 0)`)
    }
    return nodes
  }
  throw new TargetResolutionError(
    'TARGET_NOT_FOUND',
    'each target must be a uid string, {"selector": "..."}, or {"role": "...", "name": "..."}',
  )
}

// ───────────────────────── Per-element measurement ─────────────────────────

const FACTS_FN = `function (needText) {
  var num = function (v) { var n = parseFloat(v); return isFinite(n) ? n : 0; };
  var cs = getComputedStyle(this);
  var r = this.getBoundingClientRect();
  var sx = window.scrollX, sy = window.scrollY;
  var hasBox = !(r.width === 0 && r.height === 0 && this.getClientRects().length === 0);
  var bl = num(cs.borderLeftWidth), brw = num(cs.borderRightWidth);
  var bt = num(cs.borderTopWidth), bb = num(cs.borderBottomWidth);
  var pl = num(cs.paddingLeft), prw = num(cs.paddingRight);
  var pt = num(cs.paddingTop), pb = num(cs.paddingBottom);
  // getBoundingClientRect is post-transform while computed border/padding widths
  // are pre-transform: derive the effective scale from the local border-box size
  // so content boxes stay correct under (ancestor) scale transforms. Rotation is
  // approximated as the axis-aligned bounding box, like DOM.getBoxModel unions.
  var localW = num(cs.width) + pl + prw + bl + brw;
  var localH = num(cs.height) + pt + pb + bt + bb;
  var scaleX = localW > 0 && isFinite(r.width / localW) ? r.width / localW : 1;
  var scaleY = localH > 0 && isFinite(r.height / localH) ? r.height / localH : 1;
  if (Math.abs(scaleX - 1) < 0.001) scaleX = 1;
  if (Math.abs(scaleY - 1) < 0.001) scaleY = 1;
  var out = {
    hasBox: hasBox,
    border: { x: r.left + sx, y: r.top + sy, width: r.width, height: r.height },
    content: {
      x: r.left + (bl + pl) * scaleX + sx,
      y: r.top + (bt + pt) * scaleY + sy,
      width: Math.max(0, r.width - (bl + brw + pl + prw) * scaleX),
      height: Math.max(0, r.height - (bt + bb + pt + pb) * scaleY),
    },
    computed: {
      display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
      'text-overflow': cs.textOverflow, color: cs.color,
      'background-color': cs.backgroundColor, 'border-top-color': cs.borderTopColor,
      position: cs.position,
    },
    text: null,
  };
  if (needText) {
    var rects = [];
    try {
      var range = document.createRange();
      range.selectNodeContents(this);
      var rs = range.getClientRects();
      for (var i = 0; i < rs.length && i < 40; i++) {
        var q = rs[i];
        if (q.width > 0 && q.height > 0) rects.push({ x: q.left + sx, y: q.top + sy, width: q.width, height: q.height });
      }
    } catch (e) { /* detached range — no text rects */ }
    out.text = {
      scrollWidth: this.scrollWidth, clientWidth: this.clientWidth,
      scrollHeight: this.scrollHeight, clientHeight: this.clientHeight,
      textOverflow: cs.textOverflow, textRects: rects,
    };
  }
  return out;
}`

interface RawFacts {
  hasBox: boolean
  border: Bounds
  content: Bounds
  computed: Record<string, string>
  text: TextEvidence | null
}

function identityOf(ctx: ToolContext, uid: string): string {
  const entry = ctx.uids.get(uid)
  if (!entry?.tag) return ''
  const id = entry.attrId ? `#${entry.attrId}` : ''
  const cls = entry.classes?.length ? `.${entry.classes.slice(0, 2).join('.')}` : ''
  return `<${entry.tag}${id}${cls}>`
}

async function measureElement(ctx: ToolContext, node: ResolvedNode, needText: boolean): Promise<MeasuredElement> {
  const { object } = await ctx.cdp.send('DOM.resolveNode', {
    backendNodeId: node.backendNodeId,
    objectGroup: OBJECT_GROUP,
  })
  if (!object.objectId) throw new Error(`could not resolve ${node.uid} to a live object — take a fresh page_snapshot`)
  const res = await ctx.cdp.send('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: FACTS_FN,
    arguments: [{ value: needText }],
    returnByValue: true,
  })
  if (res.exceptionDetails) {
    throw new Error(`measurement failed for ${node.uid}: ${res.exceptionDetails.text}`)
  }
  const raw = res.result.value as RawFacts
  const el: MeasuredElement = {
    uid: node.uid,
    identity: identityOf(ctx, node.uid),
    computed: raw.computed,
  }
  if (raw.hasBox) {
    el.border = raw.border
    el.content = raw.content
  }
  if (raw.text) el.text = raw.text
  return el
}

// ───────────────────────── Ancestors (clips + centering container) ─────────────────────────

const ANCESTORS_FN = `function () {
  var num = function (v) { var n = parseFloat(v); return isFinite(n) ? n : 0; };
  var sx = window.scrollX, sy = window.scrollY;
  var BIG = 1e9;
  var els = [];
  var meta = [];
  // Overflow only clips descendants whose CONTAINING-BLOCK chain passes through
  // the clipping box: position:absolute escapes static overflow ancestors up to
  // its containing block, position:fixed escapes everything up to a transformed
  // (or otherwise CB-establishing) ancestor. Track the effective position and
  // "restart" it at each containing-block hop.
  var cbForFixed = function (cs) {
    return cs.transform !== 'none' || cs.perspective !== 'none' || (cs.filter && cs.filter !== 'none') ||
      (cs.backdropFilter && cs.backdropFilter !== 'none') ||
      (cs.willChange && /transform|perspective|filter/.test(cs.willChange)) ||
      (cs.contain && /paint|layout|strict|content/.test(cs.contain)) ||
      (cs.containerType && cs.containerType !== 'normal');
  };
  var effPos = getComputedStyle(this).position;
  var p = this.parentElement;
  var isParent = true;
  while (p) {
    var cs = getComputedStyle(p);
    var r = p.getBoundingClientRect();
    var bl = num(cs.borderLeftWidth), brw = num(cs.borderRightWidth);
    var bt = num(cs.borderTopWidth), bb = num(cs.borderBottomWidth);
    var pl = num(cs.paddingLeft), prw = num(cs.paddingRight);
    var pt = num(cs.paddingTop), pb = num(cs.paddingBottom);
    // Scale pre-transform inset widths into post-transform rect space (see FACTS_FN).
    var localW = num(cs.width) + pl + prw + bl + brw;
    var localH = num(cs.height) + pt + pb + bt + bb;
    var scX = localW > 0 && isFinite(r.width / localW) ? r.width / localW : 1;
    var scY = localH > 0 && isFinite(r.height / localH) ? r.height / localH : 1;
    if (Math.abs(scX - 1) < 0.001) scX = 1;
    if (Math.abs(scY - 1) < 0.001) scY = 1;
    var clipX = cs.overflowX !== 'visible';
    var clipY = cs.overflowY !== 'visible';
    var isCBForAbs = cs.position !== 'static' || cbForFixed(cs);
    var mayClip = effPos === 'fixed' ? cbForFixed(cs) : effPos === 'absolute' ? isCBForAbs : true;
    // Overflow clips at the PADDING box; a non-clipping axis is widened to ±1e9
    // so the pure evaluator only sees exceedance on genuinely clipped axes.
    var clipRect = {
      x: clipX ? r.left + bl * scX + sx : -BIG,
      y: clipY ? r.top + bt * scY + sy : -BIG,
      width: clipX ? Math.max(0, r.width - (bl + brw) * scX) : 2 * BIG,
      height: clipY ? Math.max(0, r.height - (bt + bb) * scY) : 2 * BIG,
    };
    var entry = {
      isParent: isParent,
      clips: mayClip && (clipX || clipY),
      overflow: cs.overflowX === cs.overflowY ? cs.overflowX : cs.overflowX + ' ' + cs.overflowY,
      clipRect: clipRect,
      contentRect: {
        x: r.left + (bl + pl) * scX + sx,
        y: r.top + (bt + pt) * scY + sy,
        width: Math.max(0, r.width - (bl + brw + pl + prw) * scX),
        height: Math.max(0, r.height - (bt + bb + pt + pb) * scY),
      },
    };
    if (entry.isParent || entry.clips) { meta.push(entry); els.push(p); }
    // Crossed this ancestor: if it terminated the out-of-flow escape, the rest
    // of the walk is governed by ITS position; otherwise keep escaping.
    if (effPos === 'fixed') {
      if (cbForFixed(cs)) effPos = cs.position;
    } else if (effPos === 'absolute') {
      if (isCBForAbs) effPos = cs.position;
    } else {
      effPos = cs.position;
    }
    isParent = false;
    p = p.parentElement;
  }
  return [JSON.stringify(meta)].concat(els);
}`

interface AncestorMeta {
  isParent: boolean
  clips: boolean
  overflow: string
  clipRect: Bounds
  contentRect: Bounds
}

export interface AncestorFacts {
  parent?: { uid: string; identity: string; contentRect: Bounds }
  clips: Array<{ uid: string; identity: string; overflow: string; rect: Bounds }>
}

/** Parent content box + clipping ancestors for a node (shared with diagnose). */
export async function ancestorFacts(ctx: ToolContext, node: ResolvedNode): Promise<AncestorFacts> {
  const { object } = await ctx.cdp.send('DOM.resolveNode', {
    backendNodeId: node.backendNodeId,
    objectGroup: OBJECT_GROUP,
  })
  if (!object.objectId) return { clips: [] }
  const res = await ctx.cdp.send('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: ANCESTORS_FN,
    returnByValue: false,
    objectGroup: OBJECT_GROUP,
  })
  if (res.exceptionDetails || !res.result.objectId) return { clips: [] }
  const props = await ctx.cdp.send('Runtime.getProperties', { objectId: res.result.objectId, ownProperties: true })
  const indexed = props.result
    .filter((p) => /^\d+$/.test(p.name) && p.value !== undefined)
    .sort((a, b) => Number(a.name) - Number(b.name))
  const meta = JSON.parse(String(indexed[0]?.value?.value ?? '[]')) as AncestorMeta[]

  const out: AncestorFacts = { clips: [] }
  for (let i = 0; i < meta.length; i++) {
    const m = meta[i]!
    const objectId = indexed[i + 1]?.value?.objectId
    let uid = `ancestor#${i + 1}`
    if (typeof objectId === 'string') {
      try {
        const described = await ctx.cdp.send('DOM.describeNode', { objectId })
        const attrs = pairAttributes(described.node.attributes)
        uid = ctx.uids.assign(described.node.backendNodeId, {
          tag: described.node.nodeName.toLowerCase(),
          classes: (attrs.get('class') ?? '').split(/\s+/).filter(Boolean),
          attrId: attrs.get('id'),
        })
      } catch {
        // identity fallback below still names the ancestor by position
      }
    }
    const identity = identityOf(ctx, uid)
    if (m.isParent) out.parent = { uid, identity, contentRect: m.contentRect }
    if (m.clips) out.clips.push({ uid, identity, overflow: m.overflow, rect: m.clipRect })
  }
  return out
}

// ───────────────────────── Paint order (DOMSnapshot, lazy) ─────────────────────────

const ELEMENT_NODE = 1
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'BASE', 'TITLE', 'HTML'])

export interface PaintIndex {
  /** backendNodeId → paint order (elements with a layout box only). */
  orderOf(backendNodeId: number): number | undefined
  /** Candidates painted above `backendNodeId` whose bounds intersect `rect`, excluding its ancestors/descendants. */
  candidatesAbove(backendNodeId: number, rect: Bounds): Array<{ backendNodeId: number; rect: Bounds; paintOrder: number }>
  /** Elements whose bounds intersect `rect` (document CSS px), topmost paint order first. */
  intersecting(rect: Bounds, max?: number): Array<{ backendNodeId: number; rect: Bounds; paintOrder: number }>
}

/**
 * Styles requested per layout row — used to drop candidates that cannot paint
 * anything themselves (empty transparent portal/overlay containers, opacity:0
 * leftovers). visibility:hidden needs no entry: Chrome omits paint orders for
 * hidden layout objects entirely (verified empirically).
 */
const PAINT_STYLES = [
  'opacity',
  'background-color',
  'background-image',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'box-shadow',
] as const

/** Elements whose content paints regardless of backgrounds/borders. */
const REPLACED_TAGS = new Set([
  'IMG', 'SVG', 'CANVAS', 'VIDEO', 'PICTURE', 'INPUT', 'SELECT', 'TEXTAREA', 'BUTTON',
  'IFRAME', 'EMBED', 'OBJECT', 'AUDIO', 'PROGRESS', 'METER', 'HR',
])

const TEXT_NODE = 3

export async function buildPaintIndex(ctx: ToolContext): Promise<PaintIndex> {
  const snap = await ctx.cdp.send('DOMSnapshot.captureSnapshot', {
    computedStyles: [...PAINT_STYLES],
    includePaintOrder: true,
  })
  const doc = snap.documents[0]
  const empty: PaintIndex = { orderOf: () => undefined, candidatesAbove: () => [], intersecting: () => [] }
  if (!doc) return empty
  const strings = snap.strings
  const nodes = doc.nodes
  const layout = doc.layout
  const parentIndex = nodes.parentIndex ?? []
  const nodeTypes = nodes.nodeType ?? []
  const nodeNames = nodes.nodeName ?? []
  const backendIds = nodes.backendNodeId ?? []
  const pseudo = new Set(nodes.pseudoType?.index ?? [])

  const rowByNode = new Map<number, number>()
  layout.nodeIndex.forEach((nodeIdx, row) => {
    if (!rowByNode.has(nodeIdx)) rowByNode.set(nodeIdx, row)
  })
  const nodeIdxByBackend = new Map<number, number>()
  backendIds.forEach((b, i) => {
    if (!nodeIdxByBackend.has(b)) nodeIdxByBackend.set(b, i)
  })
  const boundsOf = (row: number): Bounds | undefined => {
    const r = layout.bounds[row]
    if (!r || r.length < 4) return undefined
    return { x: r[0]!, y: r[1]!, width: r[2]!, height: r[3]! }
  }
  const orderOfIdx = (i: number): number | undefined => {
    const row = rowByNode.get(i)
    return row === undefined ? undefined : layout.paintOrders?.[row]
  }
  const isAncestorOf = (maybeAncestor: number, idx: number): boolean => {
    let p = parentIndex[idx]
    while (p !== undefined && p >= 0) {
      if (p === maybeAncestor) return true
      p = parentIndex[p]
    }
    return false
  }
  const intersects = (a: Bounds, b: Bounds): boolean =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

  // Per-row computed-style accessor (styles arrive in PAINT_STYLES request order).
  const styleIdx = new Map<string, number>()
  PAINT_STYLES.forEach((p, i) => styleIdx.set(p, i))
  const styleOf = (row: number, prop: (typeof PAINT_STYLES)[number]): string => {
    const arr = layout.styles[row]
    const i = styleIdx.get(prop)
    if (!arr || i === undefined) return ''
    return strings[arr[i] ?? -1] ?? ''
  }
  const transparent = (color: string): boolean => {
    if (color === '' || color === 'transparent') return true
    const parsed = parseCssColor(color)
    return parsed !== undefined && parsed[3] === 0
  }
  /** Does this element paint anything ITSELF (not via descendants)? Empty transparent
   *  portal/overlay containers must not count as occluders. */
  const paintsItself = (i: number, row: number): boolean => {
    const name = (strings[nodeNames[i] ?? -1] ?? '').toUpperCase()
    if (REPLACED_TAGS.has(name)) return true
    if (!transparent(styleOf(row, 'background-color'))) return true
    const bgImage = styleOf(row, 'background-image')
    if (bgImage !== '' && bgImage !== 'none') return true
    const shadow = styleOf(row, 'box-shadow')
    if (shadow !== '' && shadow !== 'none') return true
    for (const side of ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'] as const) {
      const w = parseFloat(styleOf(row, side))
      if (Number.isFinite(w) && w > 0) return true
    }
    // Own text: a direct child text node with a positive-area layout box.
    for (let c = 0; c < nodeTypes.length; c++) {
      if (parentIndex[c] !== i || nodeTypes[c] !== TEXT_NODE) continue
      const textRow = rowByNode.get(c)
      if (textRow === undefined) continue
      const tb = boundsOf(textRow)
      if (tb && tb.width > 0 && tb.height > 0) return true
    }
    return false
  }
  /** opacity:0 hides the whole subtree — check self and every ancestor. */
  const opacityChainZero = (i: number): boolean => {
    let n: number | undefined = i
    while (n !== undefined && n >= 0) {
      const row = rowByNode.get(n)
      if (row !== undefined) {
        const op = parseFloat(styleOf(row, 'opacity'))
        if (Number.isFinite(op) && op <= 0) return true
      }
      n = parentIndex[n]
    }
    return false
  }

  return {
    orderOf(backendNodeId: number): number | undefined {
      const i = nodeIdxByBackend.get(backendNodeId)
      return i === undefined ? undefined : orderOfIdx(i)
    },
    intersecting(rect: Bounds, max = 5) {
      const out: Array<{ backendNodeId: number; rect: Bounds; paintOrder: number }> = []
      for (let i = 0; i < nodeTypes.length; i++) {
        if (nodeTypes[i] !== ELEMENT_NODE || pseudo.has(i)) continue
        const name = strings[nodeNames[i] ?? -1]
        if (name === undefined || SKIP_TAGS.has(name.toUpperCase())) continue
        const row = rowByNode.get(i)
        if (row === undefined) continue
        const order = layout.paintOrders?.[row]
        if (order === undefined) continue
        const b = boundsOf(row)
        if (!b || b.width <= 0 || b.height <= 0 || !intersects(b, rect)) continue
        const backend = backendIds[i]
        if (backend === undefined) continue
        out.push({ backendNodeId: backend, rect: b, paintOrder: order })
      }
      out.sort((a, b) => b.paintOrder - a.paintOrder)
      return out.slice(0, max)
    },
    candidatesAbove(backendNodeId: number, rect: Bounds) {
      const target = nodeIdxByBackend.get(backendNodeId)
      if (target === undefined) return []
      const targetOrder = orderOfIdx(target)
      if (targetOrder === undefined) return []
      const out: Array<{ backendNodeId: number; rect: Bounds; paintOrder: number }> = []
      for (let i = 0; i < nodeTypes.length; i++) {
        if (i === target || nodeTypes[i] !== ELEMENT_NODE || pseudo.has(i)) continue
        const name = strings[nodeNames[i] ?? -1]
        if (name === undefined || SKIP_TAGS.has(name.toUpperCase())) continue
        const order = orderOfIdx(i)
        if (order === undefined || order <= targetOrder) continue
        const row = rowByNode.get(i)!
        const b = boundsOf(row)
        if (!b || b.width <= 0 || b.height <= 0 || !intersects(b, rect)) continue
        // Containment is not overlap: skip the target's own ancestors and descendants.
        if (isAncestorOf(i, target) || isAncestorOf(target, i)) continue
        // An element that paints nothing itself (empty transparent portal root,
        // opacity:0 leftover) occludes nothing — its painting DESCENDANTS are
        // separate candidates and stay in.
        if (!paintsItself(i, row) || opacityChainZero(i)) continue
        const backend = backendIds[i]
        if (backend === undefined) continue
        out.push({ backendNodeId: backend, rect: b, paintOrder: order })
      }
      return out
    },
  }
}

// ───────────────────────── Painted-pixel sampling (lazy screenshot) ─────────────────────────

async function captureViewportPng(ctx: ToolContext): Promise<DecodedPng | undefined> {
  try {
    const shot = await ctx.cdp.send('Page.captureScreenshot', { format: 'png' })
    return decodePng(Buffer.from(shot.data, 'base64'))
  } catch {
    return undefined
  }
}

/**
 * Sample the composited pixel just inside the content box's top-left corner
 * (viewport-visible targets only). The image→CSS scale is derived from the
 * decoded image itself, NOT window.devicePixelRatio: under deviceScaleFactor
 * emulation Chrome reports dpr 2 while Page.captureScreenshot returns a
 * CSS-px-sized image (verified empirically), so trusting dpr samples the wrong
 * pixel. Ground truth = image dimensions / layout viewport.
 */
function samplePixel(png: DecodedPng, facts: PageFacts, contentDoc: Bounds): Rgba | undefined {
  if (facts.viewport.width <= 0 || facts.viewport.height <= 0) return undefined
  const scaleX = png.width / facts.viewport.width
  const scaleY = png.height / facts.viewport.height
  const inset = Math.min(2, contentDoc.width / 4, contentDoc.height / 4)
  const vx = contentDoc.x - facts.scrollX + inset
  const vy = contentDoc.y - facts.scrollY + inset
  const px = Math.round(vx * scaleX)
  const py = Math.round(vy * scaleY)
  if (px < 0 || py < 0 || px >= png.width || py >= png.height) return undefined
  const [r, g, b, a] = png.pixelAt(px, py)
  return [r, g, b, a / 255]
}

// ───────────────────────── Orchestrator ─────────────────────────

export interface RunAssertionsOptions {
  tolerancePx?: number
  stopOnFirstFail?: boolean
}

export interface RunAssertionsOutput {
  results: AssertionResult[]
  /** Number of assertions skipped by stop_on_first_fail. */
  skipped: number
}

/**
 * Resolve, measure, and evaluate every assertion against the current render.
 * Per-assertion failures become ERROR results; this only throws on session-level
 * problems (no browser). Shared with responsive_sweep.
 */
export async function runAssertions(
  ctx: ToolContext,
  specs: AssertionSpec[],
  opts: RunAssertionsOptions = {},
): Promise<RunAssertionsOutput> {
  const tolerance = opts.tolerancePx ?? DEFAULT_TOLERANCE_PX
  const facts = await pageFacts(ctx)

  // Lazy shared captures — at most one DOMSnapshot and one screenshot per run.
  let paintIndex: PaintIndex | undefined
  const paint = async (): Promise<PaintIndex> => (paintIndex ??= await buildPaintIndex(ctx))
  let png: DecodedPng | undefined | 'failed'
  const screenshot = async (): Promise<DecodedPng | undefined> => {
    if (png === undefined) png = (await captureViewportPng(ctx)) ?? 'failed'
    return png === 'failed' ? undefined : png
  }

  const results: AssertionResult[] = []
  let skipped = 0
  try {
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i]!
      if (opts.stopOnFirstFail && results.some((r) => r.verdict !== 'PASS')) {
        skipped = specs.length - i
        break
      }
      results.push(await runOne(ctx, spec, facts, tolerance, paint, screenshot))
    }
  } finally {
    await ctx.cdp.send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => {})
  }
  return { results, skipped }
}

async function runOne(
  ctx: ToolContext,
  spec: AssertionSpec,
  facts: PageFacts,
  tolerance: number,
  paint: () => Promise<PaintIndex>,
  screenshot: () => Promise<DecodedPng | undefined>,
): Promise<AssertionResult> {
  const errResult = (code: 'TARGET_NOT_FOUND' | 'TARGET_AMBIGUOUS' | 'MEASUREMENT_FAILED' | 'INVALID_PARAMS', msg: string): AssertionResult => {
    const out: AssertionResult = { type: spec.type, verdict: 'ERROR', error: code, explanation: msg }
    if (spec.id !== undefined) out.id = spec.id
    return out
  }

  if (!isAssertionType(spec.type)) {
    // Let the pure layer produce the canonical UNKNOWN_ASSERTION_TYPE message.
    return evaluateAssertion(spec, { elements: [], viewport: facts.viewport, dpr: facts.dpr }, tolerance)
  }
  if (!Array.isArray(spec.targets) || spec.targets.length === 0) {
    return errResult('INVALID_PARAMS', 'assertion needs a non-empty targets array')
  }

  // 1. Resolve every target entry (selector/role entries expand to all matches).
  // Sequential on purpose: concurrent DOM.getDocument/querySelectorAll races the
  // DOM agent's node-id invalidation (observed: the first root goes stale mid-flight).
  let nodes: ResolvedNode[]
  try {
    nodes = []
    for (const t of spec.targets) nodes.push(...(await resolveAssertTarget(ctx, t)))
  } catch (e) {
    if (e instanceof TargetResolutionError) return errResult(e.code, e.message)
    if (isSessionDeath(e)) throw e
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.startsWith('Invalid CSS selector')) return errResult('INVALID_PARAMS', msg)
    if (/Unknown uid|no longer resolves|No element matches/i.test(msg)) return errResult('TARGET_NOT_FOUND', msg)
    return errResult('MEASUREMENT_FAILED', msg)
  }
  // Dedupe (a selector plus an explicit uid may name the same element).
  const seen = new Set<string>()
  nodes = nodes.filter((n) => (seen.has(n.uid) ? false : (seen.add(n.uid), true)))

  const [minArity, maxArity] = ARITY[spec.type]
  if (nodes.length < minArity) {
    return errResult('TARGET_NOT_FOUND', `${spec.type} needs at least ${minArity} element(s); targets resolved to ${nodes.length}`)
  }
  if (nodes.length > maxArity) {
    return errResult(
      'TARGET_AMBIGUOUS',
      `${spec.type} takes exactly ${maxArity} element(s); targets resolved to ${nodes.length} — narrow the selector`,
    )
  }

  // 2. Measure.
  const needText = spec.type === 'text_not_truncated' || spec.type === 'text_not_overflowing'
  let elements: MeasuredElement[]
  try {
    elements = []
    for (const node of nodes) elements.push(await measureElement(ctx, node, needText))
  } catch (e) {
    if (isSessionDeath(e)) throw e
    return errResult('MEASUREMENT_FAILED', e instanceof Error ? e.message : String(e))
  }

  const evidence: AssertionEvidence = { elements, viewport: facts.viewport, dpr: facts.dpr }

  try {
    // 3. Type-specific evidence.
    if (spec.type === 'centered') {
      if ((spec.params?.in ?? 'parent') === 'viewport') {
        evidence.container = { rect: facts.viewport, kind: 'viewport' }
      } else {
        const anc = await ancestorFacts(ctx, nodes[0]!)
        if (anc.parent) {
          evidence.container = { uid: anc.parent.uid, rect: anc.parent.contentRect, kind: 'parent' }
        }
      }
    }
    if (spec.type === 'not_clipped') {
      const anc = await ancestorFacts(ctx, nodes[0]!)
      evidence.ancestorClips = anc.clips
    }
    if (spec.type === 'z_above') {
      const idx = await paint()
      for (const el of elements) {
        const node = nodes.find((n) => n.uid === el.uid)!
        el.paintOrder = idx.orderOf(node.backendNodeId)
      }
    }
    if (spec.type === 'not_overlapped') {
      const idx = await paint()
      const target = nodes[0]!
      const box = elements[0]!.border ?? elements[0]!.content
      if (box) {
        let candidates = idx.candidatesAbove(target.backendNodeId, box)
        // params.by restricts the overlap check to specific elements.
        if (spec.params?.by !== undefined) {
          try {
            const byNodes = await resolveAssertTarget(ctx, spec.params.by)
            const allowed = new Set(byNodes.map((n) => n.backendNodeId))
            candidates = candidates.filter((c) => allowed.has(c.backendNodeId))
          } catch (e) {
            if (e instanceof TargetResolutionError) return errResult(e.code, `params.by: ${e.message}`)
            throw e
          }
        }
        evidence.overlaps = []
        for (const cand of candidates.slice(0, 10)) {
          let uid = ctx.uids.byBackendId(cand.backendNodeId)
          if (!uid || identityOf(ctx, uid) === '') {
            // Enrich with tag/id/class so the verdict names the occluder readably.
            try {
              const pushed = (await ctx.cdp.send('DOM.pushNodesByBackendIdsToFrontend', {
                backendNodeIds: [cand.backendNodeId],
              })) as Protocol.DOM.PushNodesByBackendIdsToFrontendResponse
              const nodeId = pushed.nodeIds[0]
              uid = nodeId ? (await describeAndAssign(ctx, nodeId)).uid : registerBackend(ctx, cand.backendNodeId)
            } catch {
              uid = registerBackend(ctx, cand.backendNodeId)
            }
          }
          evidence.overlaps.push({ uid, identity: identityOf(ctx, uid), rect: cand.rect, paintOrder: cand.paintOrder })
        }
      }
    }
    if ((spec.type === 'color_equals' || spec.type === 'color_near') && spec.params?.property === 'background') {
      const el = elements[0]!
      const box = el.content ?? el.border
      const png = box ? await screenshot() : undefined
      if (png && box) el.sampledColor = samplePixel(png, facts, box)
    }
  } catch (e) {
    if (isSessionDeath(e)) throw e
    return errResult('MEASUREMENT_FAILED', e instanceof Error ? e.message : String(e))
  }

  // 4. Pure evaluation.
  return evaluateAssertion(spec, evidence, tolerance)
}

function registerBackend(ctx: ToolContext, backendNodeId: number): string {
  return ctx.uids.assign(backendNodeId)
}
