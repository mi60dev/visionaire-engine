/**
 * diagnose engine — v-next SPEC §3E. One-shot "why is this broken" with ranked
 * deterministic culprits. No AI inside: every culprit is a measured fact.
 *
 * Symptom checks (all coordinates DOCUMENT CSS px):
 *   clipped      — ancestorFacts clips vs the element's content box, per side.
 *   overflowing  — scrollWidth/Height vs clientWidth/Height ('content_overflow')
 *                  + text-node Range rects vs the content box ('text_overflow').
 *                  When text exceedance explains the scroll overflow (within
 *                  TEXT_EXPLAINS_SCROLL_PX), the redundant content_overflow
 *                  culprit is dropped and its scroll metrics fold into the
 *                  text_overflow evidence.
 *   not_centered — left/right + top/bottom gap asymmetry of the border box
 *                  inside the parent content box (or the viewport). An axis
 *                  where the element OVERFLOWS the container (negative gap) is
 *                  skipped — that is an overflow problem, not a centering one.
 *   invisible    — assessVisibility status mapped to 'invisible_<status>'.
 *   overlapping  — paint-order candidatesAbove intersected with the border box.
 *   wrong_size   — content box vs expected px; the constraining property's
 *                  cascade winner (selector + value + important) is named.
 *   auto         — ordered battery invisible → clipped → overflowing →
 *                  overlapping → not_centered (+ wrong_size only when expected
 *                  dimensions were given). First tripped symptom becomes
 *                  symptom_detected; other tripped checks still appear as
 *                  lower-ranked culprits.
 *
 * SCORING (fixed, documented — determinism is the contract):
 *   TRIP_EPSILON_PX = 0.5   magnitudes at or below this do not trip at all.
 *   confidence high         magnitude > HIGH_THRESHOLD_PX (4) or a boolean
 *                           cause (e.g. display:none) — boolean causes carry
 *                           BOOLEAN_MAGNITUDE (1e6) so they always rank first.
 *   confidence medium       magnitude in (MEDIUM_THRESHOLD_PX (1), 4].
 *   confidence low          magnitude in (0.5, 1].
 *   ordering                (belongs-to-detected-symptom desc, confidence desc,
 *                           magnitude desc); ties keep emission order (stable
 *                           sort), which is battery order, nearest-ancestor
 *                           first for clips, topmost paint order for overlaps.
 *   overlap magnitude       min(overlapWidth, overlapHeight) — how deep the
 *                           topmost element intrudes.
 *   cap                     max_culprits (default 5, clamped 1..10);
 *                           truncated=true when candidates were dropped.
 * Nothing tripped → culprits [], symptom_detected 'none', summary
 * 'renders as expected within tolerances (…checks run)'.
 */
import type { Bounds, ResolvedNode, ToolContext } from '../types.js'
import { sanitizePageText } from '../types.js'
import { pairAttributes, resolveTarget } from '../uid.js'
import { ancestorFacts, buildPaintIndex } from './assert-collect.js'
import { assessVisibility } from './visibility.js'
import { computeCascade } from './cascade.js'

// ───────────────────────── Cross-agent contract ─────────────────────────

export type DiagnoseSymptom =
  'clipped' | 'overflowing' | 'not_centered' | 'invisible' | 'overlapping' | 'wrong_size' | 'auto'

export interface DiagnoseInput {
  target: { uid?: string; selector?: string; x?: number; y?: number }
  symptom?: DiagnoseSymptom
  expected?: {
    width_px?: number
    height_px?: number
    centered_in?: 'parent' | 'viewport'
  }
  max_culprits?: number
}

export interface DiagnoseCulprit {
  rank: number
  confidence: 'high' | 'medium' | 'low'
  cause: string
  plain: string
  evidence: Record<string, unknown>
}

export interface DiagnoseReport {
  summary: string
  symptom_detected: string
  culprits: DiagnoseCulprit[]
  truncated: boolean
}

// ───────────────────────── Scoring constants ─────────────────────────

const TRIP_EPSILON_PX = 0.5
const MEDIUM_THRESHOLD_PX = 1
const HIGH_THRESHOLD_PX = 4
const BOOLEAN_MAGNITUDE = 1e6
const DEFAULT_MAX_CULPRITS = 5
/** content_overflow is redundant when text exceedance explains it within this many px. */
const TEXT_EXPLAINS_SCROLL_PX = 2
/** At most this many overlap culprits (topmost paint order first). */
const MAX_OVERLAP_CANDIDATES = 3

const OBJECT_GROUP = 'visionaire-diagnose'
/** ancestorFacts (assert-collect) parks its remote objects in this group; released here too. */
const ASSERT_OBJECT_GROUP = 'visionaire-assert'

// ───────────────────────── Small helpers ─────────────────────────

const round1 = (n: number): number => Math.round(n * 10) / 10

function confidenceOf(magnitude: number): 'high' | 'medium' | 'low' {
  if (magnitude > HIGH_THRESHOLD_PX) return 'high'
  if (magnitude > MEDIUM_THRESHOLD_PX) return 'medium'
  return 'low'
}

const clean = (s: string, max = 120): string => sanitizePageText(s, max)

function identityOf(ctx: ToolContext, uid: string): string {
  const entry = ctx.uids.get(uid)
  if (!entry?.tag) return ''
  const id = entry.attrId ? `#${entry.attrId}` : ''
  const cls = entry.classes?.length ? `.${entry.classes.slice(0, 2).join('.')}` : ''
  return `<${entry.tag}${id}${cls}>`
}

interface TargetInfo {
  uid: string
  identity: string
}

interface Candidate {
  symptom: Exclude<DiagnoseSymptom, 'auto'>
  cause: string
  plain: string
  evidence: Record<string, unknown>
  magnitude: number
}

const SIDES = ['left', 'right', 'top', 'bottom'] as const
type Side = (typeof SIDES)[number]

// ───────────────────────── In-page measurement ─────────────────────────

/**
 * One callFunctionOn gathers everything geometric: border/content box, scroll
 * metrics, per-text-node Range rects (glyph extents — child element boxes are
 * deliberately NOT included so text_overflow means literal text). Document px.
 */
const FACTS_FN = `function () {
  var num = function (v) { var n = parseFloat(v); return isFinite(n) ? n : 0; };
  var cs = getComputedStyle(this);
  var r = this.getBoundingClientRect();
  var sx = window.scrollX, sy = window.scrollY;
  var hasBox = !(r.width === 0 && r.height === 0 && this.getClientRects().length === 0);
  var bl = num(cs.borderLeftWidth), brw = num(cs.borderRightWidth);
  var bt = num(cs.borderTopWidth), bb = num(cs.borderBottomWidth);
  var pl = num(cs.paddingLeft), prw = num(cs.paddingRight);
  var pt = num(cs.paddingTop), pb = num(cs.paddingBottom);
  var rects = [];
  try {
    var walker = document.createTreeWalker(this, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode()) && rects.length < 40) {
      if (!node.textContent || node.textContent.trim().length === 0) continue;
      var range = document.createRange();
      range.selectNodeContents(node);
      var rs = range.getClientRects();
      for (var i = 0; i < rs.length && rects.length < 40; i++) {
        var q = rs[i];
        if (q.width > 0 && q.height > 0) {
          rects.push({ x: q.left + sx, y: q.top + sy, width: q.width, height: q.height });
        }
      }
    }
  } catch (e) { /* detached range — no text rects */ }
  // Scale pre-transform inset widths into post-transform rect space (mirrors
  // assert-collect.ts FACTS_FN — content boxes stay correct under scale transforms).
  var localW = num(cs.width) + pl + prw + bl + brw;
  var localH = num(cs.height) + pt + pb + bt + bb;
  var scX = localW > 0 && isFinite(r.width / localW) ? r.width / localW : 1;
  var scY = localH > 0 && isFinite(r.height / localH) ? r.height / localH : 1;
  if (Math.abs(scX - 1) < 0.001) scX = 1;
  if (Math.abs(scY - 1) < 0.001) scY = 1;
  return {
    hasBox: hasBox,
    boxSizing: cs.boxSizing,
    border: { x: r.left + sx, y: r.top + sy, width: r.width, height: r.height },
    content: {
      x: r.left + (bl + pl) * scX + sx,
      y: r.top + (bt + pt) * scY + sy,
      width: Math.max(0, r.width - (bl + brw + pl + prw) * scX),
      height: Math.max(0, r.height - (bt + bb + pt + pb) * scY),
    },
    scroll: {
      scrollWidth: this.scrollWidth, clientWidth: this.clientWidth,
      scrollHeight: this.scrollHeight, clientHeight: this.clientHeight,
    },
    textRects: rects,
    viewport: {
      x: sx, y: sy,
      width: (document.documentElement && document.documentElement.clientWidth) || window.innerWidth,
      height: (document.documentElement && document.documentElement.clientHeight) || window.innerHeight,
    },
  };
}`

interface ElementFacts {
  hasBox: boolean
  boxSizing: string
  border: Bounds
  content: Bounds
  scroll: {
    scrollWidth: number
    clientWidth: number
    scrollHeight: number
    clientHeight: number
  }
  textRects: Bounds[]
  viewport: Bounds
}

async function measureFacts(ctx: ToolContext, node: ResolvedNode): Promise<ElementFacts> {
  const { object } = await ctx.cdp.send('DOM.resolveNode', {
    backendNodeId: node.backendNodeId,
    objectGroup: OBJECT_GROUP,
  })
  if (!object.objectId) {
    throw new Error(`could not resolve ${node.uid} to a live object — take a fresh page_snapshot`)
  }
  const res = await ctx.cdp.send('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: FACTS_FN,
    returnByValue: true,
  })
  if (res.exceptionDetails) {
    throw new Error(`measurement failed for ${node.uid}: ${res.exceptionDetails.text}`)
  }
  return res.result.value as ElementFacts
}

// ───────────────────────── Symptom checks ─────────────────────────

async function checkInvisible(ctx: ToolContext, node: ResolvedNode, t: TargetInfo): Promise<Candidate[]> {
  const rep = await assessVisibility(ctx, node)
  if (rep.visible) return []
  const evidence: Record<string, unknown> = { status: rep.status }
  if (rep.cause !== undefined) evidence['detail'] = clean(rep.cause, 160)
  if (rep.causeUid !== undefined) evidence['cause_uid'] = rep.causeUid
  return [
    {
      symptom: 'invisible',
      cause: `invisible_${rep.status}`,
      magnitude: BOOLEAN_MAGNITUDE,
      plain: `${t.uid} ${t.identity} is not visible: ${clean(rep.cause ?? rep.status, 160)}`,
      evidence,
    },
  ]
}

async function checkClipped(
  ctx: ToolContext,
  node: ResolvedNode,
  facts: ElementFacts,
  t: TargetInfo,
): Promise<Candidate[]> {
  const anc = await ancestorFacts(ctx, node)
  const out: Candidate[] = []
  const c = facts.content
  // clips are ordered nearest → root; ties in the stable sort keep the nearest first.
  for (const clip of anc.clips) {
    const exceed: Record<Side, number> = {
      left: round1(clip.rect.x - c.x),
      right: round1(c.x + c.width - (clip.rect.x + clip.rect.width)),
      top: round1(clip.rect.y - c.y),
      bottom: round1(c.y + c.height - (clip.rect.y + clip.rect.height)),
    }
    const sides = SIDES.filter((s) => exceed[s] > TRIP_EPSILON_PX)
    if (sides.length === 0) continue
    const magnitude = Math.max(...sides.map((s) => exceed[s]))
    const evidence: Record<string, unknown> = {
      ancestor_uid: clip.uid,
      ancestor_identity: clean(clip.identity),
      overflow: clean(clip.overflow, 40),
    }
    for (const s of sides) evidence[`exceed_${s}`] = exceed[s]
    out.push({
      symptom: 'clipped',
      cause: 'ancestor_overflow_clip',
      magnitude,
      plain:
        `${t.uid} ${t.identity} sticks out of clipping ancestor ${clip.uid} ${clean(clip.identity)} ` +
        `(overflow:${clean(clip.overflow, 40)}) by ${sides.map((s) => `${exceed[s]}px ${s}`).join(', ')}`,
      evidence,
    })
  }
  return out
}

function union(rects: Bounds[]): Bounds {
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (const r of rects) {
    x1 = Math.min(x1, r.x)
    y1 = Math.min(y1, r.y)
    x2 = Math.max(x2, r.x + r.width)
    y2 = Math.max(y2, r.y + r.height)
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
}

function checkOverflowing(facts: ElementFacts, t: TargetInfo): Candidate[] {
  const out: Candidate[] = []
  const s = facts.scroll
  const overflowX = s.scrollWidth - s.clientWidth
  const overflowY = s.scrollHeight - s.clientHeight
  const scrollMagnitude = Math.max(overflowX, overflowY)

  let textCand: Candidate | undefined
  if (facts.textRects.length > 0) {
    const u = union(facts.textRects)
    const c = facts.content
    const exceed: Record<Side, number> = {
      left: round1(c.x - u.x),
      right: round1(u.x + u.width - (c.x + c.width)),
      top: round1(c.y - u.y),
      bottom: round1(u.y + u.height - (c.y + c.height)),
    }
    const sides = SIDES.filter((side) => exceed[side] > TRIP_EPSILON_PX)
    if (sides.length > 0) {
      const magnitude = Math.max(...sides.map((side) => exceed[side]))
      const evidence: Record<string, unknown> = {
        scroll_width: s.scrollWidth,
        client_width: s.clientWidth,
        scroll_height: s.scrollHeight,
        client_height: s.clientHeight,
      }
      for (const side of sides) evidence[`exceed_${side}`] = exceed[side]
      textCand = {
        symptom: 'overflowing',
        cause: 'text_overflow',
        magnitude,
        plain:
          `text inside ${t.uid} ${t.identity} escapes its content box by ` +
          sides.map((side) => `${exceed[side]}px ${side}`).join(', '),
        evidence,
      }
      out.push(textCand)
    }
  }

  const contentTrips = scrollMagnitude > TRIP_EPSILON_PX
  const redundant = textCand !== undefined && scrollMagnitude - textCand.magnitude <= TEXT_EXPLAINS_SCROLL_PX
  if (contentTrips && !redundant) {
    const parts: string[] = []
    if (overflowX > TRIP_EPSILON_PX)
      parts.push(`${overflowX}px wider (scrollWidth ${s.scrollWidth} vs clientWidth ${s.clientWidth})`)
    if (overflowY > TRIP_EPSILON_PX)
      parts.push(`${overflowY}px taller (scrollHeight ${s.scrollHeight} vs clientHeight ${s.clientHeight})`)
    out.push({
      symptom: 'overflowing',
      cause: 'content_overflow',
      magnitude: scrollMagnitude,
      plain: `content of ${t.uid} ${t.identity} is ${parts.join(' and ')} than its box`,
      evidence: {
        overflow_x: Math.max(0, overflowX),
        overflow_y: Math.max(0, overflowY),
        scroll_width: s.scrollWidth,
        client_width: s.clientWidth,
        scroll_height: s.scrollHeight,
        client_height: s.clientHeight,
      },
    })
  }
  return out
}

async function checkNotCentered(
  ctx: ToolContext,
  node: ResolvedNode,
  facts: ElementFacts,
  t: TargetInfo,
  centeredIn: 'parent' | 'viewport',
): Promise<Candidate[]> {
  let rect: Bounds
  let label: string
  const evidenceBase: Record<string, unknown> = { container: centeredIn }
  if (centeredIn === 'viewport') {
    rect = facts.viewport
    label = 'the viewport'
  } else {
    const anc = await ancestorFacts(ctx, node)
    if (!anc.parent) return []
    rect = anc.parent.contentRect
    label = `parent ${anc.parent.uid} ${clean(anc.parent.identity)}`
    evidenceBase['container_uid'] = anc.parent.uid
    evidenceBase['container_identity'] = clean(anc.parent.identity)
  }

  const b = facts.border
  const gaps = {
    x: {
      first: b.x - rect.x,
      second: rect.x + rect.width - (b.x + b.width),
      names: ['left', 'right'] as const,
    },
    y: {
      first: b.y - rect.y,
      second: rect.y + rect.height - (b.y + b.height),
      names: ['top', 'bottom'] as const,
    },
  }
  const out: Candidate[] = []
  for (const axis of ['x', 'y'] as const) {
    const g = gaps[axis]
    // A negative gap means the element overflows the container on that axis —
    // that is an overflow/clipping problem, not an off-center one.
    if (Math.min(g.first, g.second) < -TRIP_EPSILON_PX) continue
    const delta = round1(Math.abs(g.first - g.second))
    if (delta <= TRIP_EPSILON_PX) continue
    const offBy = round1(delta / 2)
    const direction =
      axis === 'x' ? (g.first > g.second ? 'right' : 'left') : g.first > g.second ? 'down' : 'up'
    out.push({
      symptom: 'not_centered',
      cause: 'off_center',
      magnitude: delta,
      plain:
        `${t.uid} ${t.identity} is off-center in ${label} on the ${axis} axis: ` +
        `${g.names[0]} gap ${round1(g.first)}px vs ${g.names[1]} gap ${round1(g.second)}px ` +
        `(${offBy}px too far ${direction})`,
      evidence: {
        ...evidenceBase,
        axis,
        [`gap_${g.names[0]}`]: round1(g.first),
        [`gap_${g.names[1]}`]: round1(g.second),
        off_by_px: offBy,
      },
    })
  }
  return out
}

async function checkOverlapping(
  ctx: ToolContext,
  node: ResolvedNode,
  facts: ElementFacts,
  t: TargetInfo,
): Promise<Candidate[]> {
  const idx = await buildPaintIndex(ctx)
  const box = facts.border
  const targetOrder = idx.orderOf(node.backendNodeId)
  const candidates = idx
    .candidatesAbove(node.backendNodeId, box)
    .sort((a, b) => b.paintOrder - a.paintOrder)
    .slice(0, MAX_OVERLAP_CANDIDATES)

  const out: Candidate[] = []
  for (const cand of candidates) {
    const ox = Math.max(box.x, cand.rect.x)
    const oy = Math.max(box.y, cand.rect.y)
    const ow = round1(Math.min(box.x + box.width, cand.rect.x + cand.rect.width) - ox)
    const oh = round1(Math.min(box.y + box.height, cand.rect.y + cand.rect.height) - oy)
    if (ow <= TRIP_EPSILON_PX || oh <= TRIP_EPSILON_PX) continue
    let uid = ctx.uids.byBackendId(cand.backendNodeId)
    if (uid === undefined) {
      try {
        const described = await ctx.cdp.send('DOM.describeNode', {
          backendNodeId: cand.backendNodeId,
        })
        const attrs = pairAttributes(described.node.attributes)
        uid = ctx.uids.assign(cand.backendNodeId, {
          tag: described.node.nodeName.toLowerCase(),
          classes: (attrs.get('class') ?? '').split(/\s+/).filter(Boolean),
          attrId: attrs.get('id'),
        })
      } catch {
        uid = ctx.uids.assign(cand.backendNodeId)
      }
    }
    const identity = identityOf(ctx, uid)
    const evidence: Record<string, unknown> = {
      above_uid: uid,
      above_identity: clean(identity),
      overlap_x: round1(ox),
      overlap_y: round1(oy),
      overlap_width: ow,
      overlap_height: oh,
      paint_order_above: cand.paintOrder,
    }
    if (targetOrder !== undefined) evidence['paint_order_target'] = targetOrder
    out.push({
      symptom: 'overlapping',
      cause: 'overlapped_by_sibling',
      magnitude: Math.min(ow, oh),
      plain:
        `${uid} ${clean(identity)} paints on top of ${t.uid} ${t.identity}, ` +
        `covering a ${ow}x${oh}px region at (${round1(ox)}, ${round1(oy)})`,
      evidence,
    })
  }
  return out
}

const SIZE_PROPERTIES = [
  'width',
  'height',
  'max-width',
  'min-width',
  'max-height',
  'min-height',
  'flex-basis',
]

function constrainingProperty(
  axis: 'width' | 'height',
  computed: Map<string, string>,
  targetPx: number,
): string {
  const near = (v: string | undefined): boolean => {
    const m = /^(-?\d+(?:\.\d+)?)px$/.exec(v ?? '')
    return m !== null && Math.abs(Number(m[1]) - targetPx) <= 1
  }
  const upper = axis === 'width' ? 'max-width' : 'max-height'
  const lower = axis === 'width' ? 'min-width' : 'min-height'
  if (near(computed.get(upper))) return upper
  if (near(computed.get(lower))) return lower
  const fb = computed.get('flex-basis')
  if (fb !== undefined && fb !== 'auto' && near(fb)) return 'flex-basis'
  return axis
}

async function checkWrongSize(
  ctx: ToolContext,
  node: ResolvedNode,
  facts: ElementFacts,
  t: TargetInfo,
  expected: { width_px?: number; height_px?: number } | undefined,
): Promise<Candidate[]> {
  const dims: Array<{
    axis: 'width' | 'height'
    expectedPx: number
    measured: number
    declared: number
  }> = []
  if (expected?.width_px !== undefined) {
    dims.push({
      axis: 'width',
      expectedPx: expected.width_px,
      measured: facts.content.width,
      // px declarations target the border box under border-box sizing.
      declared: facts.boxSizing === 'border-box' ? facts.border.width : facts.content.width,
    })
  }
  if (expected?.height_px !== undefined) {
    dims.push({
      axis: 'height',
      expectedPx: expected.height_px,
      measured: facts.content.height,
      declared: facts.boxSizing === 'border-box' ? facts.border.height : facts.content.height,
    })
  }
  if (dims.length === 0) return []

  let computed: Map<string, string> | undefined
  let verdicts: ReturnType<typeof computeCascade> | undefined
  const out: Candidate[] = []
  for (const d of dims) {
    const delta = round1(Math.abs(d.measured - d.expectedPx))
    if (delta <= TRIP_EPSILON_PX) continue
    if (verdicts === undefined) {
      try {
        const matched = await ctx.cdp.send('CSS.getMatchedStylesForNode', {
          nodeId: node.nodeId,
        })
        const computedRes = await ctx.cdp.send('CSS.getComputedStyleForNode', {
          nodeId: node.nodeId,
        })
        computed = new Map(computedRes.computedStyle.map((p) => [p.name, p.value]))
        verdicts = computeCascade(matched, computed, {
          properties: SIZE_PROPERTIES,
        })
      } catch {
        verdicts = [] // attribution unavailable — still report the measured mismatch
      }
    }
    const prop = computed ? constrainingProperty(d.axis, computed, d.declared) : d.axis
    const verdict = verdicts.find((v) => v.property === prop)
    const winner =
      verdict?.winner !== undefined && verdict.winner.originType !== 'user-agent' ? verdict.winner : undefined

    const evidence: Record<string, unknown> = {
      axis: d.axis,
      measured_px: round1(d.measured),
      expected_px: d.expectedPx,
      delta_px: delta,
      constraining_property: prop,
    }
    let driver: string
    if (winner) {
      const where =
        winner.selector !== undefined
          ? clean(winner.selector, 80)
          : winner.originType === 'inline'
            ? 'inline style'
            : winner.originType
      evidence['selector'] = where
      evidence['value'] = clean(winner.value, 60)
      evidence['important'] = winner.important
      driver = `${where} sets ${prop}: ${clean(winner.value, 60)}${winner.important ? ' !important' : ''}`
    } else {
      driver = 'no authored declaration found — the size is layout-driven'
      evidence['note'] = driver
    }
    out.push({
      symptom: 'wrong_size',
      cause: 'size_driven_by_declaration',
      magnitude: delta,
      plain:
        `${t.uid} ${t.identity} ${d.axis} is ${round1(d.measured)}px, expected ${d.expectedPx}px ` +
        `(off by ${delta}px) — ${driver}`,
      evidence,
    })
  }
  return out
}

// ───────────────────────── Orchestrator ─────────────────────────

const GEOMETRIC_SYMPTOMS: ReadonlySet<DiagnoseSymptom> = new Set([
  'clipped',
  'overflowing',
  'not_centered',
  'overlapping',
  'wrong_size',
])

const CONF_RANK = { high: 2, medium: 1, low: 0 } as const

export async function runDiagnose(ctx: ToolContext, input: DiagnoseInput): Promise<DiagnoseReport> {
  const symptom = input.symptom ?? 'auto'
  const maxCulprits = Math.max(1, Math.min(10, Math.floor(input.max_culprits ?? DEFAULT_MAX_CULPRITS)))
  if (
    symptom === 'wrong_size' &&
    input.expected?.width_px === undefined &&
    input.expected?.height_px === undefined
  ) {
    throw new Error(
      'symptom "wrong_size" needs expected.width_px and/or expected.height_px — pass an expected size',
    )
  }

  const node = await resolveTarget(ctx, input.target)
  const t: TargetInfo = { uid: node.uid, identity: identityOf(ctx, node.uid) }
  const centeredIn = input.expected?.centered_in ?? 'parent'

  try {
    const facts = await measureFacts(ctx, node)
    if (symptom !== 'auto' && symptom !== 'invisible' && !facts.hasBox) {
      throw new Error(
        `target ${node.uid} has no layout box (display:none or detached) — diagnose it with symptom "invisible" or "auto" first`,
      )
    }

    // Battery in the documented order; explicit symptoms run just their check.
    const battery: Array<{
      name: Exclude<DiagnoseSymptom, 'auto'>
      run: () => Promise<Candidate[]>
    }> = []
    const want = (s: Exclude<DiagnoseSymptom, 'auto'>): boolean => symptom === 'auto' || symptom === s
    if (want('invisible'))
      battery.push({
        name: 'invisible',
        run: () => checkInvisible(ctx, node, t),
      })
    if (facts.hasBox) {
      if (want('clipped'))
        battery.push({
          name: 'clipped',
          run: () => checkClipped(ctx, node, facts, t),
        })
      if (want('overflowing')) {
        battery.push({
          name: 'overflowing',
          run: () => Promise.resolve(checkOverflowing(facts, t)),
        })
      }
      if (want('overlapping')) {
        battery.push({
          name: 'overlapping',
          run: () => checkOverlapping(ctx, node, facts, t),
        })
      }
      if (want('not_centered')) {
        battery.push({
          name: 'not_centered',
          run: () => checkNotCentered(ctx, node, facts, t, centeredIn),
        })
      }
      const wantSize =
        symptom === 'wrong_size' ||
        (symptom === 'auto' &&
          (input.expected?.width_px !== undefined || input.expected?.height_px !== undefined))
      if (wantSize) {
        battery.push({
          name: 'wrong_size',
          run: () => checkWrongSize(ctx, node, facts, t, input.expected),
        })
      }
    }

    const checksRun: string[] = []
    const candidates: Candidate[] = []
    let detected = 'none'
    for (const check of battery) {
      checksRun.push(check.name)
      const found = await check.run()
      if (found.length > 0 && detected === 'none') detected = check.name
      candidates.push(...found)
    }

    // Fixed documented scoring: detected symptom first, then confidence, then
    // magnitude; the sort is stable so ties keep battery/emission order.
    candidates.sort(
      (a, b) =>
        (b.symptom === detected ? 1 : 0) - (a.symptom === detected ? 1 : 0) ||
        CONF_RANK[confidenceOf(b.magnitude)] - CONF_RANK[confidenceOf(a.magnitude)] ||
        b.magnitude - a.magnitude,
    )
    const culprits: DiagnoseCulprit[] = candidates.slice(0, maxCulprits).map((c, i) => ({
      rank: i + 1,
      confidence: confidenceOf(c.magnitude),
      cause: c.cause,
      plain: c.plain,
      evidence: c.evidence,
    }))
    const truncated = candidates.length > maxCulprits

    let summary: string
    if (detected === 'none') {
      summary =
        `${t.uid} ${t.identity} renders as expected within tolerances ` +
        `(${checksRun.length} checks run: ${checksRun.join(', ')})`
    } else {
      const first = culprits[0]!
      const more =
        culprits.length > 1 ? ` (+${culprits.length - 1} more culprit${culprits.length > 2 ? 's' : ''})` : ''
      summary = `${detected}: ${first.plain}${more}`
    }

    return { summary, symptom_detected: detected, culprits, truncated }
  } finally {
    await ctx.cdp.send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => {})
    await ctx.cdp.send('Runtime.releaseObjectGroup', { objectGroup: ASSERT_OBJECT_GROUP }).catch(() => {})
  }
}
