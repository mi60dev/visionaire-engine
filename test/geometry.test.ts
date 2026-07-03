import { describe, expect, it } from 'vitest'
import {
  centeringDeltas,
  inkBox,
  measureExpression,
  type ContentBox,
  type InkMetrics,
} from '../src/engine/geometry.js'

/** A content box centered at (cx, cy) with the given size. */
function box(cx: number, cy: number, w: number, h: number): ContentBox {
  return { x: cx - w / 2, y: cy - h / 2, width: w, height: h }
}

/**
 * Build InkMetrics whose resolved ink box is centered at (cx, cy) with symmetric
 * extents of half-width hw and half-height hh. With textLeft=cx-hw, left=0,
 * right=2*hw the absolute ink spans [cx-hw, cx+hw]; with baseline=cy+hh,
 * ascent=2*hh, descent=0 the vertical ink spans [cy-hh, cy+hh].
 */
function inkCenteredAt(cx: number, cy: number, hw: number, hh: number): InkMetrics {
  return {
    textLeft: cx - hw,
    baseline: cy + hh,
    left: 0,
    right: 2 * hw,
    ascent: 2 * hh,
    descent: 0,
    advance: 2 * hw,
    empty: false,
  }
}

describe('inkBox — resolving raw metrics to an absolute box', () => {
  it('places ink left of the pen by actualBoundingBoxLeft and spans ascent/descent about the baseline', () => {
    // Mirrors the verified "×" probe: pen at 1193, left=-1.26, right=8.07,
    // baseline 43, ascent 9.0625, descent -2.25.
    const ib = inkBox({
      textLeft: 1193,
      baseline: 43,
      left: -1.2578125,
      right: 8.0703125,
      ascent: 9.0625,
      descent: -2.25,
      advance: 9.34,
      empty: false,
    })
    expect(ib.centerX).toBeCloseTo(1197.66, 1)
    expect(ib.centerY).toBeCloseTo(37.34, 1)
    // descent is negative → ink is entirely above the baseline, height = ascent+descent.
    expect(ib.height).toBeCloseTo(6.81, 1)
    expect(ib.top).toBeCloseTo(33.94, 1)
    expect(ib.bottom).toBeCloseTo(40.75, 1)
  })
})

describe('centeringDeltas — pure centering math', () => {
  it('reports ~0 on both axes for a perfectly centered glyph', () => {
    const b = box(100, 100, 40, 40)
    const ink = inkBox(inkCenteredAt(100, 100, 6, 8))
    const c = centeringDeltas(b, ink)
    expect(c.horizontal).toBe(0)
    expect(c.vertical).toBe(0)
    expect(c.hint).toMatch(/centered/i)
  })

  it('positive horizontal = ink right of center, and hints to shift left', () => {
    const b = box(100, 100, 40, 40)
    const ink = inkBox(inkCenteredAt(106.1, 100, 5, 8)) // ink center 6.1px right
    const c = centeringDeltas(b, ink)
    expect(c.horizontal).toBeCloseTo(6.1, 1)
    expect(c.vertical).toBe(0)
    expect(c.hint).toContain('6.1px')
    expect(c.hint).toContain('right of box center')
    expect(c.hint).toContain('shift content left')
    expect(c.hint).toContain('padding-left')
  })

  it('negative horizontal = ink left of center, and hints to shift right', () => {
    const b = box(100, 100, 40, 40)
    const ink = inkBox(inkCenteredAt(95.5, 100, 5, 8)) // 4.5px left
    const c = centeringDeltas(b, ink)
    expect(c.horizontal).toBeCloseTo(-4.5, 1)
    expect(c.hint).toContain('left of box center')
    expect(c.hint).toContain('shift content right')
    expect(c.hint).toContain('padding-right')
  })

  it('negative vertical = ink above center, and hints to nudge down', () => {
    const b = box(100, 100, 40, 40)
    const ink = inkBox(inkCenteredAt(100, 98.7, 5, 8)) // 1.3px above
    const c = centeringDeltas(b, ink)
    expect(c.horizontal).toBe(0)
    expect(c.vertical).toBeCloseTo(-1.3, 1)
    expect(c.hint).toContain('above box center')
    expect(c.hint).toContain('nudge down')
    expect(c.hint).toContain('padding-top')
  })

  it('positive vertical = ink below center, and hints to nudge up', () => {
    const b = box(100, 100, 40, 40)
    const ink = inkBox(inkCenteredAt(100, 102.4, 5, 8))
    const c = centeringDeltas(b, ink)
    expect(c.vertical).toBeCloseTo(2.4, 1)
    expect(c.hint).toContain('below box center')
    expect(c.hint).toContain('nudge up')
    expect(c.hint).toContain('padding-bottom')
  })

  it('reports both axes when off-center in both directions', () => {
    const b = box(200, 50, 32, 32)
    const ink = inkBox(inkCenteredAt(206.1, 48.7, 6, 9)) // 6.1 right, 1.3 above
    const c = centeringDeltas(b, ink)
    expect(c.horizontal).toBeCloseTo(6.1, 1)
    expect(c.vertical).toBeCloseTo(-1.3, 1)
    expect(c.hint).toContain('shift content left')
    expect(c.hint).toContain('nudge down')
    // both hint fragments joined
    expect(c.hint).toContain(';')
  })

  it('treats sub-0.5px drift as centered (no false alarms on rounding noise)', () => {
    const b = box(100, 100, 40, 40)
    const ink = inkBox(inkCenteredAt(100.3, 99.7, 5, 8))
    const c = centeringDeltas(b, ink)
    expect(c.horizontal).toBeCloseTo(0.3, 1)
    expect(c.vertical).toBeCloseTo(-0.3, 1)
    // Under the 0.5px epsilon on both axes → the "centered" verdict, not a fix hint.
    expect(c.hint).toMatch(/centered/i)
  })
})

describe('measureExpression — the in-page source string', () => {
  it('is a self-contained function using only web APIs', () => {
    const src = measureExpression()
    expect(src.startsWith('function ()')).toBe(true)
    expect(src).toContain('getComputedStyle')
    expect(src).toContain('getBoundingClientRect')
    expect(src).toContain('measureText')
    expect(src).toContain('actualBoundingBoxLeft')
    expect(src).toContain('createRange')
    // returns raw numbers — no toFixed/round in the payload builder.
    expect(src).toContain('content:')
    expect(src).toContain('ink:')
  })
})
