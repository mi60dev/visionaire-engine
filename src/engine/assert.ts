/**
 * assert_visual grammar — pure PASS/FAIL evaluation over measured rendered
 * geometry (v-next SPEC §3A/§5). The collector (assert-collect.ts) gathers
 * evidence via CDP; this module is pure math over those numbers so every
 * assertion type is unit-testable without a browser, like alignment.ts.
 *
 * Units: all rects are DOCUMENT CSS px (viewport rect + scroll offset), so
 * comparisons are stable across scroll positions. Comparisons snap values to
 * the device-pixel grid first (round at deviceScaleFactor), then apply the
 * caller's tolerance_px (default 1). No heuristics, no learned weights.
 */
import type { Bounds } from '../types.js'
import { oklabDeltaE, parseCssColor, toHex, type Rgba } from './color.js'

// ───────────────────────── Grammar types ─────────────────────────

export const ASSERTION_TYPES = [
  'equal_height',
  'equal_width',
  'aligned_edges',
  'centered',
  'gap_equals',
  'spacing_equals',
  'visible',
  'not_clipped',
  'not_overlapped',
  'within_viewport',
  'color_equals',
  'color_near',
  'z_above',
  'text_not_truncated',
  'text_not_overflowing',
  'size_equals',
  'positioned',
] as const

export type AssertionType = (typeof ASSERTION_TYPES)[number]

/** How a caller points at assertion targets: uid string, selector (ALL matches), or role+name. */
export type AssertTargetSpec = string | { selector: string } | { role: string; name?: string }

export interface AssertionParams {
  edge?: 'left' | 'right' | 'top' | 'bottom'
  in?: 'parent' | 'viewport'
  axis?: 'x' | 'y' | 'both'
  /** gap_equals: expected gap px (number); color_equals/color_near: expected CSS color (string). */
  value?: number | string
  fully?: boolean
  property?: 'text' | 'background' | 'border'
  deltaE?: number
  by?: AssertTargetSpec
  relation?: 'left_of' | 'right_of' | 'above' | 'below' | 'inside' | 'contains'
  width_px?: number
  height_px?: number
}

export interface AssertionSpec {
  id?: string
  type: AssertionType | string
  targets: AssertTargetSpec[]
  params?: AssertionParams
  tolerance_px?: number
}

/** Per-assertion error codes (assertion verdict ERROR, not FAIL) — v-next SPEC §3A. */
export type AssertionErrorCode =
  | 'TARGET_NOT_FOUND'
  | 'TARGET_AMBIGUOUS'
  | 'UNKNOWN_ASSERTION_TYPE'
  | 'INVALID_PARAMS'
  | 'MEASUREMENT_FAILED'

// ───────────────────────── Evidence (collector output) ─────────────────────────

export interface TextEvidence {
  scrollWidth: number
  clientWidth: number
  scrollHeight: number
  clientHeight: number
  textOverflow: string
  /** Union rects of the element's text nodes (document CSS px); empty when no text. */
  textRects: Bounds[]
}

export interface MeasuredElement {
  uid: string
  /** Human identity, e.g. "<div#hero.card>". */
  identity: string
  /** Content box, document CSS px. undefined when the node has no layout box. */
  content?: Bounds
  /** Border box, document CSS px. */
  border?: Bounds
  /** Computed props the grammar reads: display, visibility, opacity, text-overflow, colors. */
  computed: Record<string, string>
  paintOrder?: number
  text?: TextEvidence
  /** Composited painted sample (background assertions). */
  sampledColor?: Rgba
}

export interface AssertionEvidence {
  elements: MeasuredElement[]
  /** For `centered`: the reference box (parent content box or viewport). */
  container?: { uid?: string; rect: Bounds; kind: 'parent' | 'viewport' }
  /** Current visual viewport in document CSS px. */
  viewport: Bounds
  dpr: number
  /** For `not_clipped`: ancestors with clipping overflow, nearest first. */
  ancestorClips?: Array<{ uid: string; identity: string; overflow: string; rect: Bounds }>
  /**
   * For `not_overlapped`: candidate elements that intersect the target and paint
   * ABOVE it — the collector has already excluded the target's own ancestors and
   * descendants (a parent/child always intersects; that is containment, not overlap).
   */
  overlaps?: Array<{ uid: string; identity: string; rect: Bounds; paintOrder: number }>
}

export interface AssertionResult {
  id?: string
  type: string
  verdict: 'PASS' | 'FAIL' | 'ERROR'
  measured?: Record<string, unknown>
  offending_uids?: string[]
  offending_uids_truncated?: boolean
  explanation?: string
  /** Error code when verdict is ERROR. */
  error?: AssertionErrorCode
}

export const DEFAULT_TOLERANCE_PX = 1
/** offending_uids cap per assertion in summary detail — v-next SPEC §3A token budget. */
export const OFFENDING_UIDS_CAP = 20
/** Per-element measured arrays (values/gaps) cap — the verdict-bearing numbers (delta, tolerance) are scalar. */
export const MEASURED_VALUES_CAP = 20

/** Cap a per-element numbers array for the envelope, flagging the cut. */
function capValues(values: number[]): { list: number[]; truncated: boolean } {
  if (values.length <= MEASURED_VALUES_CAP) return { list: values, truncated: false }
  return { list: values.slice(0, MEASURED_VALUES_CAP), truncated: true }
}

// ───────────────────────── Helpers ─────────────────────────

const r1 = (v: number): number => Math.round(v * 10) / 10

/** Snap a CSS-px value to the device-pixel grid ("integer px after DPR rounding"). */
export function snapPx(v: number, dpr: number): number {
  const d = dpr > 0 ? dpr : 1
  return Math.round(v * d) / d
}

function right(b: Bounds): number {
  return b.x + b.width
}
function bottom(b: Bounds): number {
  return b.y + b.height
}

function intersect(a: Bounds, b: Bounds): Bounds | undefined {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const w = Math.min(right(a), right(b)) - x
  const h = Math.min(bottom(a), bottom(b)) - y
  if (w <= 0 || h <= 0) return undefined
  return { x, y, width: w, height: h }
}

function err(spec: AssertionSpec, code: AssertionErrorCode, explanation: string): AssertionResult {
  const out: AssertionResult = { type: spec.type, verdict: 'ERROR', error: code, explanation }
  if (spec.id !== undefined) out.id = spec.id
  return out
}

function capOffenders(result: AssertionResult): AssertionResult {
  if (result.offending_uids && result.offending_uids.length > OFFENDING_UIDS_CAP) {
    result.offending_uids = result.offending_uids.slice(0, OFFENDING_UIDS_CAP)
    result.offending_uids_truncated = true
  }
  return result
}

interface Ctx {
  spec: AssertionSpec
  ev: AssertionEvidence
  tol: number
  dpr: number
}

/** Content box, falling back to border box (e.g. replaced elements report both anyway). */
function contentOf(el: MeasuredElement): Bounds | undefined {
  return el.content ?? el.border
}
function borderOf(el: MeasuredElement): Bounds | undefined {
  return el.border ?? el.content
}

function needBoxes(
  c: Ctx,
  pick: (el: MeasuredElement) => Bounds | undefined,
  boxName: string,
): { boxes: Bounds[]; failure?: AssertionResult } {
  const boxes: Bounds[] = []
  for (const el of c.ev.elements) {
    const b = pick(el)
    if (!b) {
      return {
        boxes,
        failure: capOffenders({
          ...base(c),
          verdict: 'FAIL',
          measured: { missing_box: el.uid },
          offending_uids: [el.uid],
          explanation: `${el.uid} ${el.identity} has no rendered ${boxName} box (display:none or detached) — nothing to measure`,
        }),
      }
    }
    boxes.push(b)
  }
  return { boxes }
}

function base(c: Ctx): AssertionResult {
  const out: AssertionResult = { type: c.spec.type, verdict: 'PASS' }
  if (c.spec.id !== undefined) out.id = c.spec.id
  return out
}

// ───────────────────────── Per-type evaluators ─────────────────────────

function equalDimension(c: Ctx, dim: 'height' | 'width'): AssertionResult {
  const { boxes, failure } = needBoxes(c, contentOf, 'content')
  if (failure) return failure
  const values = boxes.map((b) => snapPx(dim === 'height' ? b.height : b.width, c.dpr))
  const max = Math.max(...values)
  const min = Math.min(...values)
  const delta = r1(max - min)
  const pass = delta <= c.tol
  const result = base(c)
  result.verdict = pass ? 'PASS' : 'FAIL'
  const capped = capValues(values.map(r1))
  result.measured = { values: capped.list, unit: 'px', delta, tolerance_px: c.tol }
  if (capped.truncated) result.measured['values_truncated'] = true
  if (!pass) {
    // Offenders: the extremes that produce the spread.
    const offenders = c.ev.elements.filter((_, i) => values[i] === max || values[i] === min).map((e) => e.uid)
    result.offending_uids = [...new Set(offenders)]
    const iMax = values.indexOf(max)
    const iMin = values.indexOf(min)
    result.explanation =
      `${c.ev.elements[iMax]!.uid} content-box ${dim} ${r1(max)}px vs ` +
      `${c.ev.elements[iMin]!.uid} ${r1(min)}px; delta ${delta}px exceeds ${c.tol}px tolerance`
  }
  return capOffenders(result)
}

function alignedEdges(c: Ctx): AssertionResult {
  const edge = c.spec.params?.edge
  if (!edge || !['left', 'right', 'top', 'bottom'].includes(edge)) {
    return err(c.spec, 'INVALID_PARAMS', "aligned_edges requires params.edge: 'left'|'right'|'top'|'bottom'")
  }
  const { boxes, failure } = needBoxes(c, borderOf, 'border')
  if (failure) return failure
  const coord = (b: Bounds): number =>
    edge === 'left' ? b.x : edge === 'right' ? right(b) : edge === 'top' ? b.y : bottom(b)
  const values = boxes.map((b) => snapPx(coord(b), c.dpr))
  const max = Math.max(...values)
  const min = Math.min(...values)
  const delta = r1(max - min)
  const pass = delta <= c.tol
  const result = base(c)
  result.verdict = pass ? 'PASS' : 'FAIL'
  const capped = capValues(values.map(r1))
  result.measured = { edge, values: capped.list, delta, tolerance_px: c.tol }
  if (capped.truncated) result.measured['values_truncated'] = true
  if (!pass) {
    // Offenders deviate from the median (the dominant alignment line).
    const sorted = [...values].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]!
    const offenders = c.ev.elements.filter((_, i) => Math.abs(values[i]! - median) > c.tol)
    result.offending_uids = (offenders.length > 0 ? offenders : c.ev.elements).map((e) => e.uid)
    result.explanation =
      `${edge} edges span ${r1(min)}..${r1(max)}px (delta ${delta}px > ${c.tol}px); ` +
      `off the ${r1(median)}px line: ${result.offending_uids.slice(0, 5).join(', ')}`
  }
  return capOffenders(result)
}

function centered(c: Ctx): AssertionResult {
  const axis = c.spec.params?.axis ?? 'both'
  if (!['x', 'y', 'both'].includes(axis)) {
    return err(c.spec, 'INVALID_PARAMS', "centered params.axis must be 'x'|'y'|'both'")
  }
  const el = c.ev.elements[0]!
  const box = borderOf(el)
  const container = c.ev.container
  if (!container) return err(c.spec, 'MEASUREMENT_FAILED', `no container resolved for centered (in: ${c.spec.params?.in ?? 'parent'})`)
  if (!box) {
    return capOffenders({
      ...base(c),
      verdict: 'FAIL',
      offending_uids: [el.uid],
      explanation: `${el.uid} has no rendered box — cannot be centered`,
    })
  }
  const measured: Record<string, unknown> = { in: container.kind, tolerance_px: c.tol }
  const offAxes: string[] = []
  if (axis === 'x' || axis === 'both') {
    const leftGap = snapPx(box.x - container.rect.x, c.dpr)
    const rightGap = snapPx(right(container.rect) - right(box), c.dpr)
    const delta = r1(Math.abs(leftGap - rightGap))
    measured.left_gap = r1(leftGap)
    measured.right_gap = r1(rightGap)
    measured.delta_x = delta
    if (delta > c.tol) offAxes.push(`x (left gap ${r1(leftGap)}px vs right gap ${r1(rightGap)}px)`)
  }
  if (axis === 'y' || axis === 'both') {
    const topGap = snapPx(box.y - container.rect.y, c.dpr)
    const bottomGap = snapPx(bottom(container.rect) - bottom(box), c.dpr)
    const delta = r1(Math.abs(topGap - bottomGap))
    measured.top_gap = r1(topGap)
    measured.bottom_gap = r1(bottomGap)
    measured.delta_y = delta
    if (delta > c.tol) offAxes.push(`y (top gap ${r1(topGap)}px vs bottom gap ${r1(bottomGap)}px)`)
  }
  const result = base(c)
  result.measured = measured
  if (offAxes.length > 0) {
    result.verdict = 'FAIL'
    result.offending_uids = [el.uid]
    result.explanation = `${el.uid} is off-center in ${container.kind}${container.uid ? ` ${container.uid}` : ''} on ${offAxes.join(' and ')}`
  }
  return capOffenders(result)
}

function gaps(c: Ctx): { entries: Array<{ from: string; to: string; gap: number }>; axis: 'x' | 'y' } | AssertionResult {
  const axis = c.spec.params?.axis
  if (axis !== 'x' && axis !== 'y') {
    return err(c.spec, 'INVALID_PARAMS', `${c.spec.type} requires params.axis: 'x'|'y'`)
  }
  const { failure } = needBoxes(c, borderOf, 'border')
  if (failure) return failure
  const withBoxes = c.ev.elements.map((el) => ({ el, box: borderOf(el)! }))
  withBoxes.sort((a, b) => (axis === 'x' ? a.box.x - b.box.x : a.box.y - b.box.y))
  const entries: Array<{ from: string; to: string; gap: number }> = []
  for (let i = 0; i + 1 < withBoxes.length; i++) {
    const a = withBoxes[i]!
    const b = withBoxes[i + 1]!
    const gap = axis === 'x' ? b.box.x - right(a.box) : b.box.y - bottom(a.box)
    entries.push({ from: a.el.uid, to: b.el.uid, gap: snapPx(gap, c.dpr) })
  }
  return { entries, axis }
}

function gapEquals(c: Ctx): AssertionResult {
  const value = c.spec.params?.value
  if (typeof value !== 'number') return err(c.spec, 'INVALID_PARAMS', 'gap_equals requires params.value (px)')
  const g = gaps(c)
  if ('verdict' in g) return g
  const offenders = g.entries.filter((e) => Math.abs(e.gap - value) > c.tol)
  const result = base(c)
  const capped = capValues(g.entries.map((e) => r1(e.gap)))
  result.measured = { axis: g.axis, gaps: capped.list, expected: value, tolerance_px: c.tol }
  if (capped.truncated) result.measured['gaps_truncated'] = true
  if (offenders.length > 0) {
    result.verdict = 'FAIL'
    result.offending_uids = [...new Set(offenders.flatMap((e) => [e.from, e.to]))]
    result.explanation = offenders
      .slice(0, 4)
      .map((e) => `${e.from}→${e.to} gap ${r1(e.gap)}px (expected ${value}±${c.tol})`)
      .join('; ')
  }
  return capOffenders(result)
}

function spacingEquals(c: Ctx): AssertionResult {
  const g = gaps(c)
  if ('verdict' in g) return g
  if (g.entries.length < 2) {
    return err(c.spec, 'INVALID_PARAMS', 'spacing_equals needs at least 3 targets (2 gaps) to compare spacing')
  }
  const values = g.entries.map((e) => e.gap)
  const max = Math.max(...values)
  const min = Math.min(...values)
  const delta = r1(max - min)
  const result = base(c)
  const capped = capValues(values.map(r1))
  result.measured = { axis: g.axis, gaps: capped.list, delta, tolerance_px: c.tol }
  if (capped.truncated) result.measured['gaps_truncated'] = true
  if (delta > c.tol) {
    const sorted = [...values].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]!
    const offenders = g.entries.filter((e) => Math.abs(e.gap - median) > c.tol)
    result.verdict = 'FAIL'
    result.offending_uids = [...new Set((offenders.length ? offenders : g.entries).flatMap((e) => [e.from, e.to]))]
    result.explanation =
      `gaps not uniform: ${values.map(r1).join(', ')}px (spread ${delta}px > ${c.tol}px); ` +
      `median ${r1(median)}px — outlier: ${(offenders[0] ?? g.entries[0])!.from}→${(offenders[0] ?? g.entries[0])!.to}`
  }
  return capOffenders(result)
}

function visible(c: Ctx): AssertionResult {
  const el = c.ev.elements[0]!
  const reasons: string[] = []
  const computed = el.computed
  if (computed['display'] === 'none') reasons.push('display:none')
  if (computed['visibility'] === 'hidden' || computed['visibility'] === 'collapse') {
    reasons.push(`visibility:${computed['visibility']}`)
  }
  const opacity = Number(computed['opacity'] ?? '1')
  if (Number.isFinite(opacity) && opacity <= 0) reasons.push('opacity:0')
  // Painted extent = the BORDER box: an <hr> or a CSS-triangle renders purely by
  // borders with a zero-area content box yet is plainly visible.
  const box = borderOf(el)
  if (!box) {
    if (reasons.length === 0) reasons.push('no layout box')
  } else if (box.width * box.height <= 0) {
    reasons.push(`zero-area border box (${r1(box.width)}x${r1(box.height)})`)
  } else if (!intersect(box, c.ev.viewport)) {
    reasons.push('outside the current viewport')
  }
  const result = base(c)
  result.measured = {
    display: computed['display'] ?? '?',
    visibility: computed['visibility'] ?? '?',
    opacity: computed['opacity'] ?? '?',
    border_box: box ? { x: r1(box.x), y: r1(box.y), width: r1(box.width), height: r1(box.height) } : null,
  }
  if (reasons.length > 0) {
    result.verdict = 'FAIL'
    result.offending_uids = [el.uid]
    result.explanation = `${el.uid} is not visible: ${reasons.join(', ')}`
  }
  return capOffenders(result)
}

function notClipped(c: Ctx): AssertionResult {
  const el = c.ev.elements[0]!
  const box = contentOf(el)
  if (!box) {
    return capOffenders({
      ...base(c),
      verdict: 'FAIL',
      offending_uids: [el.uid],
      explanation: `${el.uid} has no rendered box`,
    })
  }
  const clips = c.ev.ancestorClips ?? []
  for (const clip of clips) {
    const exceed = {
      left: r1(Math.max(0, clip.rect.x - box.x)),
      right: r1(Math.max(0, right(box) - right(clip.rect))),
      top: r1(Math.max(0, clip.rect.y - box.y)),
      bottom: r1(Math.max(0, bottom(box) - bottom(clip.rect))),
    }
    const worst = Math.max(exceed.left, exceed.right, exceed.top, exceed.bottom)
    if (worst > c.tol) {
      const sides = (Object.entries(exceed) as Array<[string, number]>)
        .filter(([, v]) => v > c.tol)
        .map(([side, v]) => `${v}px on the ${side}`)
      const result = base(c)
      result.verdict = 'FAIL'
      result.measured = { ancestor_uid: clip.uid, ancestor_overflow: clip.overflow, exceed, tolerance_px: c.tol }
      result.offending_uids = [el.uid, clip.uid]
      result.explanation =
        `${el.uid} is clipped by ancestor ${clip.uid} ${clip.identity} (overflow:${clip.overflow}) — ` +
        `content exceeds it by ${sides.join(', ')}`
      return capOffenders(result)
    }
  }
  const result = base(c)
  result.measured = { clipping_ancestors_checked: clips.length, tolerance_px: c.tol }
  return result
}

function notOverlapped(c: Ctx): AssertionResult {
  const el = c.ev.elements[0]!
  const box = borderOf(el)
  if (!box) {
    return capOffenders({
      ...base(c),
      verdict: 'FAIL',
      offending_uids: [el.uid],
      explanation: `${el.uid} has no rendered box`,
    })
  }
  const hits = (c.ev.overlaps ?? [])
    .map((o) => ({ o, rect: intersect(box, o.rect) }))
    .filter((h): h is { o: NonNullable<AssertionEvidence['overlaps']>[number]; rect: Bounds } => {
      // Overlap must exceed the tolerance on BOTH axes to count.
      return h.rect !== undefined && h.rect.width > c.tol && h.rect.height > c.tol
    })
    .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)
  const result = base(c)
  result.measured = { candidates_above: (c.ev.overlaps ?? []).length, tolerance_px: c.tol }
  if (hits.length > 0) {
    const top = hits[0]!
    result.verdict = 'FAIL'
    result.measured = {
      ...result.measured,
      overlapped_by: top.o.uid,
      overlap_rect: { x: r1(top.rect.x), y: r1(top.rect.y), width: r1(top.rect.width), height: r1(top.rect.height) },
      others: hits.slice(1, 5).map((h) => h.o.uid),
    }
    result.offending_uids = [el.uid, ...hits.map((h) => h.o.uid)]
    result.explanation =
      `${el.uid} is overlapped by ${top.o.uid} ${top.o.identity} painted above it ` +
      `(${r1(top.rect.width)}x${r1(top.rect.height)}px at ${r1(top.rect.x)},${r1(top.rect.y)})` +
      (hits.length > 1 ? ` and ${hits.length - 1} more` : '')
  }
  return capOffenders(result)
}

function withinViewport(c: Ctx): AssertionResult {
  const fully = c.spec.params?.fully ?? true
  const el = c.ev.elements[0]!
  const box = borderOf(el)
  if (!box) {
    return capOffenders({
      ...base(c),
      verdict: 'FAIL',
      offending_uids: [el.uid],
      explanation: `${el.uid} has no rendered box`,
    })
  }
  const vp = c.ev.viewport
  const inter = intersect(box, vp)
  const result = base(c)
  const out = {
    left: r1(Math.max(0, vp.x - box.x)),
    right: r1(Math.max(0, right(box) - right(vp))),
    top: r1(Math.max(0, vp.y - box.y)),
    bottom: r1(Math.max(0, bottom(box) - bottom(vp))),
  }
  result.measured = { fully, outside: out, viewport: { width: vp.width, height: vp.height }, tolerance_px: c.tol }
  const worst = Math.max(out.left, out.right, out.top, out.bottom)
  const fail = fully ? worst > c.tol : inter === undefined
  if (fail) {
    result.verdict = 'FAIL'
    result.offending_uids = [el.uid]
    const sides = (Object.entries(out) as Array<[string, number]>)
      .filter(([, v]) => v > c.tol)
      .map(([side, v]) => `${v}px past the ${side} edge`)
    result.explanation = fully
      ? `${el.uid} extends outside the viewport: ${sides.join(', ')}`
      : `${el.uid} is entirely outside the current viewport`
  }
  return capOffenders(result)
}

function colorAssert(c: Ctx): AssertionResult {
  const property = c.spec.params?.property ?? 'text'
  if (!['text', 'background', 'border'].includes(property)) {
    return err(c.spec, 'INVALID_PARAMS', "color params.property must be 'text'|'background'|'border'")
  }
  const expectedStr = c.spec.params?.value
  if (typeof expectedStr !== 'string') {
    return err(c.spec, 'INVALID_PARAMS', `${c.spec.type} requires params.value (a CSS color)`)
  }
  const expected = parseCssColor(expectedStr)
  if (!expected) return err(c.spec, 'INVALID_PARAMS', `cannot parse expected color "${expectedStr}"`)
  const maxDelta = c.spec.params?.deltaE ?? (c.spec.type === 'color_near' ? 5 : 2)

  const el = c.ev.elements[0]!
  let actual: Rgba | undefined
  let method: string
  if (property === 'background') {
    actual = el.sampledColor ?? parseCssColor(el.computed['background-color'] ?? '')
    method = el.sampledColor ? 'painted pixel sample (composited)' : 'computed background-color'
  } else if (property === 'border') {
    actual = parseCssColor(el.computed['border-top-color'] ?? '')
    method = 'computed border-top-color'
  } else {
    actual = parseCssColor(el.computed['color'] ?? '')
    method = 'computed color'
  }
  if (!actual) return err(c.spec, 'MEASUREMENT_FAILED', `could not read ${property} color of ${el.uid}`)

  const delta = r1(oklabDeltaE(actual, expected))
  const result = base(c)
  result.measured = {
    property,
    actual: toHex(actual),
    expected: toHex(expected),
    deltaE: delta,
    max_deltaE: maxDelta,
    method,
  }
  if (delta > maxDelta) {
    result.verdict = 'FAIL'
    result.offending_uids = [el.uid]
    result.explanation =
      `${el.uid} ${property} color ${toHex(actual)} vs expected ${toHex(expected)} — ` +
      `ΔE(OKLab×100) ${delta} exceeds ${maxDelta} (${method})`
  }
  return capOffenders(result)
}

function zAbove(c: Ctx): AssertionResult {
  const [a, b] = c.ev.elements
  if (!a || !b) return err(c.spec, 'INVALID_PARAMS', 'z_above requires exactly 2 targets [A, B]')
  if (a.paintOrder === undefined || b.paintOrder === undefined) {
    return err(c.spec, 'MEASUREMENT_FAILED', 'paint order unavailable for one of the targets')
  }
  const result = base(c)
  result.measured = { [a.uid]: a.paintOrder, [b.uid]: b.paintOrder }
  if (a.paintOrder <= b.paintOrder) {
    result.verdict = 'FAIL'
    result.offending_uids = [a.uid, b.uid]
    result.explanation =
      `${a.uid} paints at order ${a.paintOrder}, BELOW ${b.uid} (order ${b.paintOrder}) — expected above`
  }
  return capOffenders(result)
}

function textNotTruncated(c: Ctx): AssertionResult {
  const el = c.ev.elements[0]!
  const t = el.text
  if (!t) return err(c.spec, 'MEASUREMENT_FAILED', `no text metrics for ${el.uid}`)
  const overflowX = r1(t.scrollWidth - t.clientWidth)
  const ellipsis = (el.computed['text-overflow'] ?? t.textOverflow) === 'ellipsis'
  const result = base(c)
  result.measured = {
    scrollWidth: t.scrollWidth,
    clientWidth: t.clientWidth,
    overflow_px: overflowX,
    text_overflow: ellipsis ? 'ellipsis' : (el.computed['text-overflow'] ?? 'clip'),
    tolerance_px: c.tol,
  }
  if (overflowX > c.tol) {
    result.verdict = 'FAIL'
    result.offending_uids = [el.uid]
    result.explanation =
      `${el.uid} text is truncated: scrollWidth ${t.scrollWidth}px exceeds clientWidth ${t.clientWidth}px ` +
      `by ${overflowX}px${ellipsis ? ' (cut with an ellipsis)' : ''}`
  }
  return capOffenders(result)
}

function textNotOverflowing(c: Ctx): AssertionResult {
  const el = c.ev.elements[0]!
  const t = el.text
  const box = contentOf(el)
  if (!t || !box) return err(c.spec, 'MEASUREMENT_FAILED', `no text metrics or content box for ${el.uid}`)
  let worst = 0
  const out = { left: 0, right: 0, top: 0, bottom: 0 }
  for (const rect of t.textRects) {
    out.left = Math.max(out.left, box.x - rect.x)
    out.right = Math.max(out.right, right(rect) - right(box))
    out.top = Math.max(out.top, box.y - rect.y)
    out.bottom = Math.max(out.bottom, bottom(rect) - bottom(box))
  }
  worst = Math.max(out.left, out.right, out.top, out.bottom)
  const result = base(c)
  result.measured = {
    text_rects: t.textRects.length,
    outside: { left: r1(out.left), right: r1(out.right), top: r1(out.top), bottom: r1(out.bottom) },
    tolerance_px: c.tol,
  }
  if (worst > c.tol) {
    result.verdict = 'FAIL'
    result.offending_uids = [el.uid]
    const sides = (Object.entries(out) as Array<[string, number]>)
      .filter(([, v]) => v > c.tol)
      .map(([side, v]) => `${r1(v)}px past the ${side}`)
    result.explanation = `${el.uid} text spills outside its content box: ${sides.join(', ')}`
  }
  return capOffenders(result)
}

function sizeEquals(c: Ctx): AssertionResult {
  const wantW = c.spec.params?.width_px
  const wantH = c.spec.params?.height_px
  if (wantW === undefined && wantH === undefined) {
    return err(c.spec, 'INVALID_PARAMS', 'size_equals requires params.width_px and/or params.height_px')
  }
  const el = c.ev.elements[0]!
  const box = contentOf(el)
  if (!box) {
    return capOffenders({
      ...base(c),
      verdict: 'FAIL',
      offending_uids: [el.uid],
      explanation: `${el.uid} has no rendered box`,
    })
  }
  const w = snapPx(box.width, c.dpr)
  const h = snapPx(box.height, c.dpr)
  const problems: string[] = []
  if (wantW !== undefined && Math.abs(w - wantW) > c.tol) problems.push(`width ${r1(w)}px ≠ ${wantW}px`)
  if (wantH !== undefined && Math.abs(h - wantH) > c.tol) problems.push(`height ${r1(h)}px ≠ ${wantH}px`)
  const result = base(c)
  result.measured = {
    width: r1(w),
    height: r1(h),
    expected: { width_px: wantW ?? null, height_px: wantH ?? null },
    tolerance_px: c.tol,
  }
  if (problems.length > 0) {
    result.verdict = 'FAIL'
    result.offending_uids = [el.uid]
    result.explanation = `${el.uid} content box ${problems.join('; ')} (±${c.tol}px)`
  }
  return capOffenders(result)
}

function positioned(c: Ctx): AssertionResult {
  const relation = c.spec.params?.relation
  const relations = ['left_of', 'right_of', 'above', 'below', 'inside', 'contains']
  if (!relation || !relations.includes(relation)) {
    return err(c.spec, 'INVALID_PARAMS', `positioned requires params.relation: ${relations.join('|')}`)
  }
  const [a, b] = c.ev.elements
  if (!a || !b) return err(c.spec, 'INVALID_PARAMS', 'positioned requires exactly 2 targets [A, B]')
  const boxA = borderOf(a)
  const boxB = borderOf(b)
  if (!boxA || !boxB) {
    const missing = !boxA ? a : b
    return capOffenders({
      ...base(c),
      verdict: 'FAIL',
      offending_uids: [missing.uid],
      explanation: `${missing.uid} has no rendered box`,
    })
  }
  const t = c.tol
  let pass: boolean
  let detail: string
  switch (relation) {
    case 'left_of':
      pass = right(boxA) <= boxB.x + t
      detail = `A.right ${r1(right(boxA))} vs B.left ${r1(boxB.x)}`
      break
    case 'right_of':
      pass = boxA.x >= right(boxB) - t
      detail = `A.left ${r1(boxA.x)} vs B.right ${r1(right(boxB))}`
      break
    case 'above':
      pass = bottom(boxA) <= boxB.y + t
      detail = `A.bottom ${r1(bottom(boxA))} vs B.top ${r1(boxB.y)}`
      break
    case 'below':
      pass = boxA.y >= bottom(boxB) - t
      detail = `A.top ${r1(boxA.y)} vs B.bottom ${r1(bottom(boxB))}`
      break
    case 'inside':
      pass =
        boxA.x >= boxB.x - t && boxA.y >= boxB.y - t && right(boxA) <= right(boxB) + t && bottom(boxA) <= bottom(boxB) + t
      detail = `A ${rectStr(boxA)} vs B ${rectStr(boxB)}`
      break
    default: // contains
      pass =
        boxB.x >= boxA.x - t && boxB.y >= boxA.y - t && right(boxB) <= right(boxA) + t && bottom(boxB) <= bottom(boxA) + t
      detail = `A ${rectStr(boxA)} vs B ${rectStr(boxB)}`
  }
  const result = base(c)
  result.measured = {
    relation,
    a: { uid: a.uid, ...roundRect(boxA) },
    b: { uid: b.uid, ...roundRect(boxB) },
    tolerance_px: c.tol,
  }
  if (!pass) {
    result.verdict = 'FAIL'
    result.offending_uids = [a.uid, b.uid]
    result.explanation = `${a.uid} is not ${relation.replace('_', ' ')} ${b.uid}: ${detail} (±${c.tol}px)`
  }
  return capOffenders(result)
}

function rectStr(b: Bounds): string {
  return `${r1(b.width)}x${r1(b.height)}@(${r1(b.x)},${r1(b.y)})`
}
function roundRect(b: Bounds): Record<string, number> {
  return { x: r1(b.x), y: r1(b.y), width: r1(b.width), height: r1(b.height) }
}

// ───────────────────────── Arity table & dispatcher ─────────────────────────

/** [min resolved elements, max resolved elements (Infinity = unbounded)]. */
export const ARITY: Record<AssertionType, [number, number]> = {
  equal_height: [2, Infinity],
  equal_width: [2, Infinity],
  aligned_edges: [2, Infinity],
  centered: [1, 1],
  gap_equals: [2, Infinity],
  spacing_equals: [3, Infinity],
  visible: [1, 1],
  not_clipped: [1, 1],
  not_overlapped: [1, 1],
  within_viewport: [1, 1],
  color_equals: [1, 1],
  color_near: [1, 1],
  z_above: [2, 2],
  text_not_truncated: [1, 1],
  text_not_overflowing: [1, 1],
  size_equals: [1, 1],
  positioned: [2, 2],
}

export function isAssertionType(t: string): t is AssertionType {
  return (ASSERTION_TYPES as readonly string[]).includes(t)
}

/**
 * Evaluate one assertion against collected evidence. Pure — no CDP, no I/O.
 * The collector guarantees evidence.elements are in target order and already
 * arity-checked; this re-checks defensively and reports ERROR, never throws.
 */
export function evaluateAssertion(
  spec: AssertionSpec,
  ev: AssertionEvidence,
  globalTolerancePx = DEFAULT_TOLERANCE_PX,
): AssertionResult {
  if (!isAssertionType(spec.type)) {
    return err(spec, 'UNKNOWN_ASSERTION_TYPE', `unknown assertion type "${spec.type}" — known: ${ASSERTION_TYPES.join(', ')}`)
  }
  const [min, max] = ARITY[spec.type]
  if (ev.elements.length < min) {
    return err(
      spec,
      'TARGET_NOT_FOUND',
      `${spec.type} needs at least ${min} resolved target element(s); got ${ev.elements.length}`,
    )
  }
  if (ev.elements.length > max) {
    return err(
      spec,
      'TARGET_AMBIGUOUS',
      `${spec.type} takes at most ${max} target element(s); targets resolved to ${ev.elements.length} — narrow the selector`,
    )
  }
  const tol = spec.tolerance_px ?? globalTolerancePx
  const c: Ctx = { spec, ev, tol, dpr: ev.dpr > 0 ? ev.dpr : 1 }
  switch (spec.type) {
    case 'equal_height':
      return equalDimension(c, 'height')
    case 'equal_width':
      return equalDimension(c, 'width')
    case 'aligned_edges':
      return alignedEdges(c)
    case 'centered':
      return centered(c)
    case 'gap_equals':
      return gapEquals(c)
    case 'spacing_equals':
      return spacingEquals(c)
    case 'visible':
      return visible(c)
    case 'not_clipped':
      return notClipped(c)
    case 'not_overlapped':
      return notOverlapped(c)
    case 'within_viewport':
      return withinViewport(c)
    case 'color_equals':
    case 'color_near':
      return colorAssert(c)
    case 'z_above':
      return zAbove(c)
    case 'text_not_truncated':
      return textNotTruncated(c)
    case 'text_not_overflowing':
      return textNotOverflowing(c)
    case 'size_equals':
      return sizeEquals(c)
    case 'positioned':
      return positioned(c)
  }
}

/** Overall verdict = FAIL if any assertion is FAIL or ERROR (v-next SPEC §3A). */
export function overallVerdict(results: AssertionResult[]): 'PASS' | 'FAIL' {
  return results.every((r) => r.verdict === 'PASS') ? 'PASS' : 'FAIL'
}

export function summarize(results: AssertionResult[]): string {
  const pass = results.filter((r) => r.verdict === 'PASS').length
  const fail = results.filter((r) => r.verdict === 'FAIL').length
  const error = results.filter((r) => r.verdict === 'ERROR').length
  const parts = [`${pass} PASS`, `${fail} FAIL`]
  if (error > 0) parts.push(`${error} ERROR`)
  return `${results.length} assertion${results.length === 1 ? '' : 's'}: ${parts.join(', ')}`
}
