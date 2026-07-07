/**
 * Pure unit tests for the pixelmatch-port diff engine (src/engine/pixel-diff.ts)
 * and the minimal PNG encoder (src/engine/png-encode.ts). No Chrome.
 */
import { describe, expect, it } from 'vitest'
import { diffImages, type DiffResult, type PixelSource } from '../src/engine/pixel-diff.js'
import { encodePng } from '../src/engine/png-encode.js'
import { decodePng } from '../src/engine/png.js'

type Px = [number, number, number, number]

const WHITE: Px = [255, 255, 255, 255]
const BLACK: Px = [0, 0, 0, 255]

/** Solid-color image with optional per-pixel overrides ("x,y" keys). */
function solid(width: number, height: number, color: Px, overrides?: Map<string, Px>): PixelSource {
  return {
    width,
    height,
    pixelAt: (x, y) => overrides?.get(`${x},${y}`) ?? color,
  }
}

/** Base color with one solid rectangle painted over it. */
function withRect(
  width: number,
  height: number,
  base: Px,
  rect: { x: number; y: number; w: number; h: number },
  color: Px,
): PixelSource {
  return {
    width,
    height,
    pixelAt: (x, y) =>
      x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h ? color : base,
  }
}

/** Everything except the diffMask closure — the comparable part of a result. */
function comparable(r: DiffResult): Omit<DiffResult, 'diffMask'> {
  const { diffMask: _diffMask, ...rest } = r
  return rest
}

describe('diffImages — pixelmatch semantics', () => {
  it('identical images match with zero divergence', () => {
    const a = solid(32, 32, WHITE)
    const b = solid(32, 32, WHITE)
    const r = diffImages(a, b)
    expect(r.match).toBe(true)
    expect(r.reason).toBe('match')
    expect(r.diffPixels).toBe(0)
    expect(r.totalPixels).toBe(32 * 32)
    expect(r.divergencePct).toBe(0)
    expect(r.regions).toEqual([])
    expect(r.diffMask!(0, 0)).toBe(false)
  })

  it('detects a single changed pixel (solid change is never dismissed as AA)', () => {
    const a = solid(40, 40, WHITE)
    const b = solid(40, 40, WHITE, new Map([['25,35', BLACK]]))
    const r = diffImages(a, b) // ignoreAntialiasing defaults to true
    expect(r.match).toBe(false)
    expect(r.reason).toBe('pixel-diff')
    expect(r.diffPixels).toBe(1)
    expect(r.totalPixels).toBe(1600)
    expect(r.diffMask!(25, 35)).toBe(true)
    expect(r.diffMask!(24, 35)).toBe(false)
    expect(r.diffMask!(-1, 0)).toBe(false) // out-of-range is safe
  })

  it('threshold gates small color distances (YIQ delta vs 35215·t²)', () => {
    // Gray 200 vs 205: YIQ delta ≈ 0.5053·5² ≈ 12.6. At t=0.1 the cutoff is
    // 352.15 (no diff); at t=0.005 it is 0.88 (all pixels diff).
    const a = solid(10, 10, [200, 200, 200, 255])
    const b = solid(10, 10, [205, 205, 205, 255])
    const lenient = diffImages(a, b, { threshold: 0.1 })
    expect(lenient.match).toBe(true)
    expect(lenient.diffPixels).toBe(0)
    const strict = diffImages(a, b, { threshold: 0.005 })
    expect(strict.match).toBe(false)
    expect(strict.diffPixels).toBe(100)
    expect(strict.divergencePct).toBe(100)
  })

  it('dimension mismatch → layout-diff immediately, no per-pixel pass', () => {
    const a = solid(10, 10, WHITE)
    const b = solid(10, 11, WHITE)
    const r = diffImages(a, b)
    expect(r.match).toBe(false)
    expect(r.reason).toBe('layout-diff')
    expect(r.diffPixels).toBe(0)
    expect(r.totalPixels).toBe(0)
    expect(r.divergencePct).toBe(100)
    expect(r.regions).toEqual([])
    expect(r.diffMask).toBeUndefined()
  })

  it('ignoreRegions masks differences and shrinks totalPixels', () => {
    const a = solid(40, 40, WHITE)
    const b = withRect(40, 40, WHITE, { x: 10, y: 10, w: 10, h: 10 }, BLACK)
    const r = diffImages(a, b, { ignoreRegions: [{ x: 10, y: 10, width: 10, height: 10 }] })
    expect(r.match).toBe(true)
    expect(r.diffPixels).toBe(0)
    expect(r.totalPixels).toBe(1600 - 100)
    // Without the mask the same images diverge.
    expect(diffImages(a, b).match).toBe(false)
  })

  it('attributes diffs to the right grid cell with a tight bbox', () => {
    // 40x40 with grid 8 → 5x5 cells. Pixel (25,35) lands in row 7, col 5.
    const a = solid(40, 40, WHITE)
    const b = solid(40, 40, WHITE, new Map([['25,35', BLACK]]))
    const r = diffImages(a, b, { regionGrid: 8 })
    expect(r.regions).toHaveLength(1)
    const region = r.regions[0]!
    expect(region.grid).toBe('r7c5')
    expect(region.bbox).toEqual({ x: 25, y: 35, width: 1, height: 1 })
    // 1 differing pixel of the cell's 25 compared → 4%.
    expect(region.divergencePct).toBeCloseTo(4, 10)
  })

  it('spans multiple grid cells and sorts regions by divergence', () => {
    // 40x40, grid 4 → 10x10 cells. Rect x∈[8,12), y∈[8,12) straddles the cell
    // boundary at 10 on both axes → 4 cells, 2x2 = 4 px in each.
    const a = solid(40, 40, WHITE)
    const b = withRect(40, 40, WHITE, { x: 8, y: 8, w: 4, h: 4 }, BLACK)
    const r = diffImages(a, b, { regionGrid: 4 })
    expect(r.diffPixels).toBe(16)
    expect(r.regions).toHaveLength(4)
    expect(r.regions.map((x) => x.grid).sort()).toEqual(['r0c0', 'r0c1', 'r1c0', 'r1c1'])
    // All four cells hold 4 px of 100 → equal divergence; deterministic label order.
    expect(r.regions.map((x) => x.grid)).toEqual(['r0c0', 'r0c1', 'r1c0', 'r1c1'])
    expect(r.regions[0]!.bbox).toEqual({ x: 8, y: 8, width: 2, height: 2 })
  })

  it('AA heuristic does NOT hide a 10px solid rectangle change', () => {
    const a = solid(40, 40, WHITE)
    const b = withRect(40, 40, WHITE, { x: 10, y: 10, w: 10, h: 10 }, BLACK)
    const r = diffImages(a, b, { ignoreAntialiasing: true })
    expect(r.match).toBe(false)
    expect(r.diffPixels).toBe(100) // every rect pixel counted, none dismissed
    expect(r.regions.length).toBeGreaterThan(0)
  })

  it('AA heuristic DOES dismiss a genuine anti-aliased edge shift', () => {
    // A vertical black→gray→white edge; only the gray blend column changes
    // (128 → 140), which is exactly what font/edge anti-aliasing noise looks
    // like. threshold 0 so only the AA filter can dismiss it.
    const edge = (gray: number): PixelSource => ({
      width: 5,
      height: 5,
      pixelAt: (x) => (x < 2 ? BLACK : x === 2 ? [gray, gray, gray, 255] : WHITE),
    })
    const withAA = diffImages(edge(128), edge(140), { threshold: 0, ignoreAntialiasing: true })
    expect(withAA.match).toBe(true)
    expect(withAA.diffPixels).toBe(0)
    const withoutAA = diffImages(edge(128), edge(140), { threshold: 0, ignoreAntialiasing: false })
    expect(withoutAA.diffPixels).toBe(5)
  })

  it('semi-transparent pixels are blended onto white before comparing', () => {
    // Fully transparent black vs opaque white → both become white → no diff.
    const a = solid(8, 8, [0, 0, 0, 0])
    const b = solid(8, 8, WHITE)
    expect(diffImages(a, b).match).toBe(true)
    // Half-transparent black blends to ~gray 127.5 vs white → clear diff.
    const c = solid(8, 8, [0, 0, 0, 128])
    expect(diffImages(c, b).match).toBe(false)
  })

  it('is deterministic — two runs produce identical results', () => {
    const a = withRect(64, 64, WHITE, { x: 5, y: 9, w: 20, h: 3 }, [10, 40, 200, 255])
    const b = withRect(64, 64, WHITE, { x: 5, y: 9, w: 20, h: 3 }, [200, 40, 10, 255])
    const r1 = diffImages(a, b, { threshold: 0.05, regionGrid: 6 })
    const r2 = diffImages(a, b, { threshold: 0.05, regionGrid: 6 })
    expect(comparable(r1)).toEqual(comparable(r2))
    expect(JSON.stringify(comparable(r1))).toBe(JSON.stringify(comparable(r2)))
  })
})

describe('encodePng — round-trips through the project decoder', () => {
  it('encodes RGBA pixels decodePng reads back verbatim', () => {
    const width = 3
    const height = 2
    const rgba = Buffer.from([
      // row 0
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
      // row 1
      10, 20, 30, 40, 0, 0, 0, 0, 255, 255, 255, 128,
    ])
    const png = encodePng(width, height, rgba)
    const decoded = decodePng(png)
    expect(decoded.width).toBe(width)
    expect(decoded.height).toBe(height)
    expect(decoded.pixelAt(0, 0)).toEqual([255, 0, 0, 255])
    expect(decoded.pixelAt(1, 0)).toEqual([0, 255, 0, 255])
    expect(decoded.pixelAt(2, 0)).toEqual([0, 0, 255, 255])
    expect(decoded.pixelAt(0, 1)).toEqual([10, 20, 30, 40])
    expect(decoded.pixelAt(1, 1)).toEqual([0, 0, 0, 0])
    expect(decoded.pixelAt(2, 1)).toEqual([255, 255, 255, 128])
  })

  it('is deterministic — same pixels, same bytes', () => {
    const rgba = Buffer.alloc(4 * 4 * 4, 7)
    expect(encodePng(4, 4, rgba).equals(encodePng(4, 4, rgba))).toBe(true)
  })

  it('rejects a wrong-size buffer and bad dimensions with actionable messages', () => {
    expect(() => encodePng(2, 2, Buffer.alloc(15))).toThrow(/width\*height\*4/)
    expect(() => encodePng(0, 2, Buffer.alloc(0))).toThrow(/positive integers/)
    expect(() => encodePng(1.5, 2, Buffer.alloc(12))).toThrow(/positive integers/)
  })
})
