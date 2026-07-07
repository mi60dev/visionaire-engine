/**
 * Pure unit tests for the assert_visual grammar (src/engine/assert.ts) — no
 * Chrome. Evidence records are constructed by hand; every assertion type gets
 * PASS, FAIL, and (where applicable) ERROR coverage, plus tolerance/DPR
 * rounding, offender capping, and the envelope helpers.
 */
import { describe, expect, it } from 'vitest'
import {
  ARITY,
  ASSERTION_TYPES,
  OFFENDING_UIDS_CAP,
  evaluateAssertion,
  isAssertionType,
  overallVerdict,
  snapPx,
  summarize,
  type AssertionEvidence,
  type AssertionSpec,
  type MeasuredElement,
} from '../src/engine/assert.js'
import type { Bounds } from '../src/types.js'

const VIEWPORT: Bounds = { x: 0, y: 0, width: 1280, height: 800 }

function el(uid: string, content: Bounds, extra: Partial<MeasuredElement> = {}): MeasuredElement {
  return {
    uid,
    identity: `<div#${uid}>`,
    content,
    border: extra.border ?? content,
    computed: { display: 'block', visibility: 'visible', opacity: '1', ...extra.computed },
    ...extra,
  }
}

function ev(elements: MeasuredElement[], extra: Partial<AssertionEvidence> = {}): AssertionEvidence {
  return { elements, viewport: VIEWPORT, dpr: 1, ...extra }
}

function spec(type: string, partial: Partial<AssertionSpec> = {}): AssertionSpec {
  return { type, targets: ['e1'], ...partial }
}

describe('snapPx', () => {
  it('rounds to the device-pixel grid', () => {
    expect(snapPx(10.4, 1)).toBe(10)
    expect(snapPx(10.6, 1)).toBe(11)
    expect(snapPx(10.25, 2)).toBe(10.5)
    expect(snapPx(10.2, 0)).toBe(10) // degenerate dpr falls back to 1
  })
})

describe('equal_height / equal_width', () => {
  const a = el('e1', { x: 0, y: 0, width: 300, height: 412 })
  const b = el('e2', { x: 320, y: 0, width: 300, height: 388 })

  it('FAILs with measured values, delta, and both offenders', () => {
    const r = evaluateAssertion(spec('equal_height'), ev([a, b]))
    expect(r.verdict).toBe('FAIL')
    expect(r.measured).toMatchObject({ values: [412, 388], delta: 24, tolerance_px: 1 })
    expect(r.offending_uids).toEqual(['e1', 'e2'])
    expect(r.explanation).toContain('412')
    expect(r.explanation).toContain('388')
  })

  it('PASSes within tolerance (delta == tol passes)', () => {
    const c = el('e3', { x: 0, y: 0, width: 300, height: 411 })
    const r = evaluateAssertion(spec('equal_height', { tolerance_px: 1 }), ev([a, c]))
    expect(r.verdict).toBe('PASS')
  })

  it('equal_width PASSes on equal widths', () => {
    const r = evaluateAssertion(spec('equal_width'), ev([a, b]))
    expect(r.verdict).toBe('PASS')
  })

  it('FAILs helpfully when an element has no box', () => {
    const ghost: MeasuredElement = { uid: 'e9', identity: '<div#e9>', computed: { display: 'none' } }
    const r = evaluateAssertion(spec('equal_height'), ev([a, ghost]))
    expect(r.verdict).toBe('FAIL')
    expect(r.offending_uids).toEqual(['e9'])
  })
})

describe('aligned_edges', () => {
  const boxes = [
    el('e1', { x: 0, y: 20, width: 50, height: 50 }),
    el('e2', { x: 60, y: 20, width: 50, height: 50 }),
    el('e3', { x: 120, y: 27.5, width: 50, height: 50 }),
  ]
  it('names the off-median offender (values snap to the device-pixel grid first)', () => {
    const r = evaluateAssertion(spec('aligned_edges', { params: { edge: 'top' } }), ev(boxes))
    expect(r.verdict).toBe('FAIL')
    expect(r.offending_uids).toEqual(['e3'])
    // 27.5 snaps to 28 at dpr 1 → delta 8 ("integer px after DPR rounding")
    expect(r.measured).toMatchObject({ edge: 'top', delta: 8 })
  })
  it('PASSes when all edges line up', () => {
    const r = evaluateAssertion(spec('aligned_edges', { params: { edge: 'left' } }), ev([boxes[0]!, el('e4', { x: 0.5, y: 90, width: 10, height: 10 })]))
    expect(r.verdict).toBe('PASS')
  })
  it('ERRORs without the edge param', () => {
    const r = evaluateAssertion(spec('aligned_edges'), ev(boxes))
    expect(r.verdict).toBe('ERROR')
    expect(r.error).toBe('INVALID_PARAMS')
  })
})

describe('centered', () => {
  const child = el('e1', { x: 100, y: 10, width: 200, height: 50 })
  const container = { uid: 'e0', rect: { x: 0, y: 0, width: 400, height: 100 }, kind: 'parent' as const }

  it('PASSes with equal gaps and reports them', () => {
    const r = evaluateAssertion(spec('centered', { params: { axis: 'x' } }), ev([child], { container }))
    expect(r.verdict).toBe('PASS')
    expect(r.measured).toMatchObject({ left_gap: 100, right_gap: 100, delta_x: 0 })
  })
  it('FAILs on asymmetric gaps', () => {
    const off = el('e1', { x: 40, y: 10, width: 350, height: 50 })
    const r = evaluateAssertion(spec('centered', { params: { axis: 'x' } }), ev([off], { container }))
    expect(r.verdict).toBe('FAIL')
    expect(r.measured).toMatchObject({ left_gap: 40, right_gap: 10, delta_x: 30 })
  })
  it('checks both axes by default', () => {
    const off = el('e1', { x: 100, y: 0, width: 200, height: 50 })
    const r = evaluateAssertion(spec('centered'), ev([off], { container }))
    expect(r.verdict).toBe('FAIL')
    expect(r.explanation).toContain('y (')
  })
  it('ERRORs when no container was resolved', () => {
    const r = evaluateAssertion(spec('centered'), ev([child]))
    expect(r.verdict).toBe('ERROR')
    expect(r.error).toBe('MEASUREMENT_FAILED')
  })
})

describe('gap_equals / spacing_equals', () => {
  const items = [
    el('e1', { x: 0, y: 0, width: 60, height: 30 }),
    el('e3', { x: 152, y: 0, width: 60, height: 30 }), // out of order on purpose — must sort by position
    el('e2', { x: 76, y: 0, width: 60, height: 30 }),
    el('e4', { x: 228, y: 0, width: 60, height: 30 }),
  ]
  it('gap_equals PASSes with sorted 16px gaps', () => {
    const r = evaluateAssertion(spec('gap_equals', { params: { axis: 'x', value: 16 } }), ev(items))
    expect(r.verdict).toBe('PASS')
    expect(r.measured).toMatchObject({ gaps: [16, 16, 16], expected: 16 })
  })
  it('gap_equals FAILs and names the bad pair', () => {
    const bad = [items[0]!, items[2]!, el('e3', { x: 144, y: 0, width: 60, height: 30 })]
    const r = evaluateAssertion(spec('gap_equals', { params: { axis: 'x', value: 16 } }), ev(bad))
    expect(r.verdict).toBe('FAIL')
    expect(r.explanation).toContain('8px')
  })
  it('gap_equals ERRORs without value', () => {
    const r = evaluateAssertion(spec('gap_equals', { params: { axis: 'x' } }), ev(items))
    expect(r.error).toBe('INVALID_PARAMS')
  })
  it('spacing_equals FAILs on non-uniform gaps with the spread', () => {
    const bad = [items[0]!, items[2]!, el('e3b', { x: 144, y: 0, width: 60, height: 30 }), el('e4b', { x: 220, y: 0, width: 60, height: 30 })]
    const r = evaluateAssertion(spec('spacing_equals', { params: { axis: 'x' } }), ev(bad))
    expect(r.verdict).toBe('FAIL')
    expect(r.measured).toMatchObject({ gaps: [16, 8, 16], delta: 8 })
  })
  it('spacing_equals needs 3+ targets', () => {
    expect(ARITY.spacing_equals[0]).toBe(3)
    const r = evaluateAssertion({ type: 'spacing_equals', targets: ['e1'], params: { axis: 'x' } }, ev([items[0]!, items[2]!]))
    expect(r.verdict).toBe('ERROR')
  })
})

describe('visible', () => {
  it('FAILs on display:none with the reason', () => {
    const hidden: MeasuredElement = { uid: 'e1', identity: '<div>', computed: { display: 'none', visibility: 'visible', opacity: '1' } }
    const r = evaluateAssertion(spec('visible'), ev([hidden]))
    expect(r.verdict).toBe('FAIL')
    expect(r.explanation).toContain('display:none')
  })
  it('FAILs outside the viewport', () => {
    const off = el('e1', { x: 20, y: 1500, width: 100, height: 40 })
    const r = evaluateAssertion(spec('visible'), ev([off]))
    expect(r.verdict).toBe('FAIL')
    expect(r.explanation).toContain('outside')
  })
  it('PASSes for a normal element', () => {
    const r = evaluateAssertion(spec('visible'), ev([el('e1', { x: 10, y: 10, width: 50, height: 50 })]))
    expect(r.verdict).toBe('PASS')
  })
})

describe('not_clipped', () => {
  const target = el('e1', { x: 20, y: 640, width: 234, height: 40 })
  it('FAILs with the exceed per side and the clipping ancestor', () => {
    const clips = [{ uid: 'e0', identity: '<div#clip-wrap>', overflow: 'hidden', rect: { x: 20, y: 640, width: 200, height: 60 } }]
    const r = evaluateAssertion(spec('not_clipped'), ev([target], { ancestorClips: clips }))
    expect(r.verdict).toBe('FAIL')
    expect(r.measured).toMatchObject({ ancestor_uid: 'e0', exceed: { left: 0, right: 34, top: 0, bottom: 0 } })
    expect(r.offending_uids).toContain('e0')
  })
  it('PASSes when the content fits every clipping ancestor', () => {
    const clips = [{ uid: 'e0', identity: '<div>', overflow: 'hidden', rect: { x: 0, y: 600, width: 400, height: 100 } }]
    const r = evaluateAssertion(spec('not_clipped'), ev([target], { ancestorClips: clips }))
    expect(r.verdict).toBe('PASS')
  })
})

describe('not_overlapped', () => {
  const target = el('e1', { x: 500, y: 640, width: 100, height: 40 })
  it('FAILs with the overlap rect and the element on top', () => {
    const overlaps = [{ uid: 'e2', identity: '<div#badge>', rect: { x: 580, y: 630, width: 40, height: 30 }, paintOrder: 9 }]
    const r = evaluateAssertion(spec('not_overlapped'), ev([target], { overlaps }))
    expect(r.verdict).toBe('FAIL')
    expect(r.measured).toMatchObject({ overlapped_by: 'e2', overlap_rect: { x: 580, y: 640, width: 20, height: 20 } })
  })
  it('ignores sub-tolerance slivers (must exceed tol on BOTH axes)', () => {
    const overlaps = [{ uid: 'e2', identity: '<div>', rect: { x: 599.5, y: 630, width: 40, height: 30 }, paintOrder: 9 }]
    const r = evaluateAssertion(spec('not_overlapped'), ev([target], { overlaps }))
    expect(r.verdict).toBe('PASS')
  })
})

describe('within_viewport', () => {
  it('FAILs fully-mode when the box pokes out', () => {
    const r = evaluateAssertion(spec('within_viewport'), ev([el('e1', { x: 1250, y: 10, width: 60, height: 20 })]))
    expect(r.verdict).toBe('FAIL')
    expect(r.measured).toMatchObject({ outside: { right: 30, left: 0, top: 0, bottom: 0 } })
  })
  it('partial mode passes while any part is visible', () => {
    const r = evaluateAssertion(spec('within_viewport', { params: { fully: false } }), ev([el('e1', { x: 1250, y: 10, width: 60, height: 20 })]))
    expect(r.verdict).toBe('PASS')
  })
})

describe('color_equals / color_near', () => {
  const swatch = el('e1', { x: 0, y: 0, width: 60, height: 40 }, {
    computed: { display: 'block', visibility: 'visible', opacity: '1', color: 'rgb(0, 128, 0)', 'background-color': 'rgb(255, 0, 0)', 'border-top-color': 'rgb(0, 0, 255)' },
  })
  it('text color exact match PASSes with deltaE 0', () => {
    const r = evaluateAssertion(spec('color_equals', { params: { property: 'text', value: '#008000' } }), ev([swatch]))
    expect(r.verdict).toBe('PASS')
    expect(r.measured).toMatchObject({ actual: '#008000', expected: '#008000', deltaE: 0 })
  })
  it('background uses the painted sample when present', () => {
    const sampled = { ...swatch, sampledColor: [250, 5, 5, 1] as [number, number, number, number] }
    const r = evaluateAssertion(spec('color_near', { params: { property: 'background', value: '#ff0000' } }), ev([sampled]))
    expect(r.verdict).toBe('PASS')
    expect((r.measured as { method: string }).method).toContain('painted')
  })
  it('FAILs on a clearly different color with the ΔE', () => {
    const r = evaluateAssertion(spec('color_equals', { params: { property: 'text', value: '#0000ff' } }), ev([swatch]))
    expect(r.verdict).toBe('FAIL')
    expect((r.measured as { deltaE: number }).deltaE).toBeGreaterThan(2)
  })
  it('ERRORs on an unparseable expected color', () => {
    const r = evaluateAssertion(spec('color_equals', { params: { property: 'text', value: 'chartreuse-ish' } }), ev([swatch]))
    expect(r.error).toBe('INVALID_PARAMS')
  })
})

describe('z_above', () => {
  const a = el('e1', { x: 0, y: 0, width: 10, height: 10 }, { paintOrder: 9 })
  const b = el('e2', { x: 0, y: 0, width: 10, height: 10 }, { paintOrder: 4 })
  it('PASSes when A paints above B', () => {
    expect(evaluateAssertion({ type: 'z_above', targets: ['e1', 'e2'] }, ev([a, b])).verdict).toBe('PASS')
  })
  it('FAILs the reverse with both orders in measured', () => {
    const r = evaluateAssertion({ type: 'z_above', targets: ['e2', 'e1'] }, ev([b, a]))
    expect(r.verdict).toBe('FAIL')
    expect(r.measured).toMatchObject({ e1: 9, e2: 4 })
  })
  it('ERRORs when paint order is missing', () => {
    const r = evaluateAssertion({ type: 'z_above', targets: ['e1', 'e2'] }, ev([el('e1', { x: 0, y: 0, width: 1, height: 1 }), b]))
    expect(r.error).toBe('MEASUREMENT_FAILED')
  })
})

describe('text assertions', () => {
  const base = el('e1', { x: 0, y: 0, width: 120, height: 24 })
  it('text_not_truncated FAILs with the overflow px', () => {
    const t = { ...base, text: { scrollWidth: 402, clientWidth: 120, scrollHeight: 24, clientHeight: 24, textOverflow: 'ellipsis', textRects: [] } }
    const r = evaluateAssertion(spec('text_not_truncated'), ev([t]))
    expect(r.verdict).toBe('FAIL')
    expect(r.measured).toMatchObject({ scrollWidth: 402, clientWidth: 120, overflow_px: 282 })
    expect(r.explanation).toContain('ellipsis')
  })
  it('text_not_overflowing compares text rects to the content box', () => {
    const t = { ...base, text: { scrollWidth: 120, clientWidth: 120, scrollHeight: 24, clientHeight: 24, textOverflow: 'clip', textRects: [{ x: 0, y: 0, width: 150, height: 24 }] } }
    const r = evaluateAssertion(spec('text_not_overflowing'), ev([t]))
    expect(r.verdict).toBe('FAIL')
    expect((r.measured as { outside: { right: number } }).outside.right).toBe(30)
  })
  it('ERRORs without text metrics', () => {
    expect(evaluateAssertion(spec('text_not_truncated'), ev([base])).error).toBe('MEASUREMENT_FAILED')
  })
})

describe('size_equals / positioned', () => {
  const a = el('e1', { x: 20, y: 20, width: 300, height: 412 })
  const b = el('e2', { x: 340, y: 20, width: 300, height: 388 })
  it('size_equals checks the given dimensions only', () => {
    expect(evaluateAssertion(spec('size_equals', { params: { width_px: 300 } }), ev([a])).verdict).toBe('PASS')
    const r = evaluateAssertion(spec('size_equals', { params: { width_px: 300, height_px: 400 } }), ev([a]))
    expect(r.verdict).toBe('FAIL')
    expect(r.explanation).toContain('height')
  })
  it('size_equals ERRORs without expectations', () => {
    expect(evaluateAssertion(spec('size_equals'), ev([a])).error).toBe('INVALID_PARAMS')
  })
  it('positioned covers all six relations', () => {
    const pair = ev([a, b])
    expect(evaluateAssertion({ type: 'positioned', targets: ['e1', 'e2'], params: { relation: 'left_of' } }, pair).verdict).toBe('PASS')
    expect(evaluateAssertion({ type: 'positioned', targets: ['e1', 'e2'], params: { relation: 'right_of' } }, pair).verdict).toBe('FAIL')
    expect(evaluateAssertion({ type: 'positioned', targets: ['e1', 'e2'], params: { relation: 'above' } }, pair).verdict).toBe('FAIL')
    const inner = el('e3', { x: 30, y: 30, width: 50, height: 50 })
    expect(evaluateAssertion({ type: 'positioned', targets: ['e3', 'e1'], params: { relation: 'inside' } }, ev([inner, a])).verdict).toBe('PASS')
    expect(evaluateAssertion({ type: 'positioned', targets: ['e1', 'e3'], params: { relation: 'contains' } }, ev([a, inner])).verdict).toBe('PASS')
    expect(evaluateAssertion({ type: 'positioned', targets: ['e1', 'e2'], params: { relation: 'below' } }, pair).verdict).toBe('FAIL')
  })
})

describe('dispatcher guards', () => {
  it('rejects unknown types with the known-type list', () => {
    const r = evaluateAssertion(spec('equal_vibes'), ev([el('e1', { x: 0, y: 0, width: 1, height: 1 })]))
    expect(r.verdict).toBe('ERROR')
    expect(r.error).toBe('UNKNOWN_ASSERTION_TYPE')
    expect(r.explanation).toContain('equal_height')
  })
  it('reports arity violations as TARGET errors', () => {
    const one = el('e1', { x: 0, y: 0, width: 1, height: 1 })
    expect(evaluateAssertion(spec('equal_height'), ev([one])).error).toBe('TARGET_NOT_FOUND')
    expect(evaluateAssertion(spec('visible'), ev([one, one])).error).toBe('TARGET_AMBIGUOUS')
  })
  it('caps offending_uids and flags truncation', () => {
    const many = Array.from({ length: 30 }, (_, i) => el(`e${i}`, { x: i * 40, y: i * 3, width: 30, height: 30 }))
    const r = evaluateAssertion({ type: 'aligned_edges', targets: ['x'], params: { edge: 'top' } }, ev(many))
    expect(r.verdict).toBe('FAIL')
    expect(r.offending_uids!.length).toBeLessThanOrEqual(OFFENDING_UIDS_CAP)
    expect(r.offending_uids_truncated).toBe(true)
  })
  it('isAssertionType matches the exported list', () => {
    for (const t of ASSERTION_TYPES) expect(isAssertionType(t)).toBe(true)
    expect(isAssertionType('nope')).toBe(false)
  })
})

describe('envelope helpers', () => {
  it('overallVerdict is FAIL when any assertion FAILs or ERRORs', () => {
    expect(overallVerdict([{ type: 'visible', verdict: 'PASS' }])).toBe('PASS')
    expect(overallVerdict([{ type: 'visible', verdict: 'PASS' }, { type: 'visible', verdict: 'ERROR' }])).toBe('FAIL')
  })
  it('summarize counts verdicts', () => {
    expect(
      summarize([
        { type: 'a', verdict: 'PASS' },
        { type: 'b', verdict: 'PASS' },
        { type: 'c', verdict: 'FAIL' },
      ]),
    ).toBe('3 assertions: 2 PASS, 1 FAIL')
    expect(summarize([{ type: 'a', verdict: 'ERROR' }])).toBe('1 assertion: 0 PASS, 0 FAIL, 1 ERROR')
  })
})
