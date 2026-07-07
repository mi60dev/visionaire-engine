/**
 * Pure pixel-diff engine for visual_diff (v-next SPEC §3C) — dependency-free.
 *
 * Deliberate deviation from the spec's odiff suggestion: this is a faithful
 * TypeScript port of the pixelmatch algorithm (mapbox/pixelmatch, ISC), so the
 * engine stays pure, deterministic, and binary-free; odiff can be slotted in
 * behind the same API later.
 *
 * Algorithm constants (pixelmatch semantics, documented so a port review can
 * check them against upstream):
 *  - Perceived color difference is measured in YIQ space (Kotsarenko &
 *    Ramos, "Measuring perceived color difference using YIQ NTSC transmission
 *    color space in mobile applications"). Coefficients:
 *      Y = 0.29889531·R + 0.58662247·G + 0.11448223·B   (luma)
 *      I = 0.59597799·R − 0.27417610·G − 0.32180189·B   (orange–blue chroma)
 *      Q = 0.21147017·R − 0.52261711·G + 0.31114694·B   (purple–green chroma)
 *    delta = 0.5053·Y² + 0.299·I² + 0.1957·Q², whose maximum possible value
 *    (pure black vs pure white) is 35215. A pixel differs when
 *    |delta| > 35215 · threshold².
 *  - Semi-transparent pixels are alpha-blended onto white before comparison.
 *  - Anti-aliasing detection (Vysniauskas, "Anti-aliased pixel and intensity
 *    slope detector"): a differing pixel is dismissed as anti-aliasing when it
 *    has both darker and brighter neighbours, at most 2 equal neighbours, and
 *    its darkest or brightest neighbour sits in a flat area (3+ identical
 *    neighbours) in BOTH images.
 *
 * Coordinate space: image pixels, top-left origin — callers convert CSS px
 * via devicePixelRatio before calling in.
 *
 * Deterministic by construction: no randomness, no time, no I/O — identical
 * inputs produce identical outputs.
 */
import type { Bounds } from '../types.js'

/** Structural match for engine/png.ts's DecodedPng — any pixel source works. */
export interface PixelSource {
  width: number
  height: number
  /** [r, g, b, a] with channels 0–255, top-left origin. */
  pixelAt(x: number, y: number): [number, number, number, number]
}

export interface DiffOptions {
  /** Per-pixel YIQ color-distance threshold, 0..1 (pixelmatch semantics). Default 0.1. */
  threshold?: number
  /** Dismiss pixels the pixelmatch heuristic classifies as anti-aliasing. Default true. */
  ignoreAntialiasing?: boolean
  /** Rectangles (image-pixel space) excluded from comparison AND from totalPixels. */
  ignoreRegions?: Bounds[]
  /** Report divergence per NxN grid cell. Default 8. */
  regionGrid?: number
}

export interface DiffRegion {
  /** Grid cell label 'rXcY' — 0-based row X / column Y of the regionGrid×regionGrid grid. */
  grid: string
  /** Tight bounding box of this cell's differing pixels, image px. */
  bbox: Bounds
  /** 100 · (differing pixels in cell) / (compared pixels in cell). */
  divergencePct: number
}

export interface DiffResult {
  match: boolean
  reason: 'match' | 'pixel-diff' | 'layout-diff'
  diffPixels: number
  /** Pixels actually compared: width·height minus ignored regions (0 for layout-diff). */
  totalPixels: number
  /** 100 · diffPixels / totalPixels (100 for layout-diff). */
  divergencePct: number
  /** Non-empty grid cells, sorted by divergencePct descending (ties: grid label). */
  regions: DiffRegion[]
  /** True where a counted (non-AA, non-ignored) difference sits. Absent for layout-diff. */
  diffMask?: (x: number, y: number) => boolean
}

/** Maximum possible YIQ delta (black vs white) — pixelmatch's 35215. */
const MAX_YIQ_DELTA = 35215

function rgb2y(r: number, g: number, b: number): number {
  return r * 0.29889531 + g * 0.58662247 + b * 0.11448223
}
function rgb2i(r: number, g: number, b: number): number {
  return r * 0.59597799 - g * 0.2741761 - b * 0.32180189
}
function rgb2q(r: number, g: number, b: number): number {
  return r * 0.21147017 - g * 0.52261711 + b * 0.31114694
}

/** Blend a channel onto a white background by alpha (0..1). */
function blend(c: number, a: number): number {
  return 255 + (c - 255) * a
}

/**
 * YIQ color distance between pixel k of img1 and pixel m of img2 (flat RGBA
 * offsets). yOnly returns the signed brightness delta; otherwise the full YIQ
 * delta with the sign encoding whether the pixel darkens (+) or lightens (−).
 */
function colorDelta(img1: Uint8Array, img2: Uint8Array, k: number, m: number, yOnly: boolean): number {
  let r1 = img1[k]!
  let g1 = img1[k + 1]!
  let b1 = img1[k + 2]!
  const a1 = img1[k + 3]!
  let r2 = img2[m]!
  let g2 = img2[m + 1]!
  let b2 = img2[m + 2]!
  const a2 = img2[m + 3]!

  if (r1 === r2 && g1 === g2 && b1 === b2 && a1 === a2) return 0

  if (a1 < 255) {
    const a = a1 / 255
    r1 = blend(r1, a)
    g1 = blend(g1, a)
    b1 = blend(b1, a)
  }
  if (a2 < 255) {
    const a = a2 / 255
    r2 = blend(r2, a)
    g2 = blend(g2, a)
    b2 = blend(b2, a)
  }

  const y1 = rgb2y(r1, g1, b1)
  const y2 = rgb2y(r2, g2, b2)
  const y = y1 - y2
  if (yOnly) return y

  const i = rgb2i(r1, g1, b1) - rgb2i(r2, g2, b2)
  const q = rgb2q(r1, g1, b1) - rgb2q(r2, g2, b2)
  const delta = 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q
  return y1 > y2 ? -delta : delta
}

/** Does (x1,y1) sit in a flat area — 3+ identical RGBA neighbours (image edges credit 1)? */
function hasManySiblings(img: Uint8Array, x1: number, y1: number, width: number, height: number): boolean {
  const x0 = Math.max(x1 - 1, 0)
  const y0 = Math.max(y1 - 1, 0)
  const x2 = Math.min(x1 + 1, width - 1)
  const y2 = Math.min(y1 + 1, height - 1)
  const pos = (y1 * width + x1) * 4
  let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0

  for (let x = x0; x <= x2; x++) {
    for (let y = y0; y <= y2; y++) {
      if (x === x1 && y === y1) continue
      const pos2 = (y * width + x) * 4
      if (
        img[pos] === img[pos2] &&
        img[pos + 1] === img[pos2 + 1] &&
        img[pos + 2] === img[pos2 + 2] &&
        img[pos + 3] === img[pos2 + 3]
      ) {
        zeroes++
      }
      if (zeroes > 2) return true
    }
  }
  return false
}

/**
 * Is (x1,y1) of img likely an anti-aliased edge pixel? True when it has both a
 * darker and a brighter neighbour, at most 2 equal neighbours, and the darkest
 * or brightest neighbour has 3+ equal siblings in BOTH images.
 */
function antialiased(img: Uint8Array, x1: number, y1: number, width: number, height: number, img2: Uint8Array): boolean {
  const x0 = Math.max(x1 - 1, 0)
  const y0 = Math.max(y1 - 1, 0)
  const x2 = Math.min(x1 + 1, width - 1)
  const y2 = Math.min(y1 + 1, height - 1)
  const pos = (y1 * width + x1) * 4
  let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0
  let min = 0
  let max = 0
  let minX = x1
  let minY = y1
  let maxX = x1
  let maxY = y1

  for (let x = x0; x <= x2; x++) {
    for (let y = y0; y <= y2; y++) {
      if (x === x1 && y === y1) continue
      const delta = colorDelta(img, img, pos, (y * width + x) * 4, true)
      if (delta === 0) {
        zeroes++
        if (zeroes > 2) return false
      } else if (delta < min) {
        min = delta
        minX = x
        minY = y
      } else if (delta > max) {
        max = delta
        maxX = x
        maxY = y
      }
    }
  }

  if (min === 0 || max === 0) return false

  return (
    (hasManySiblings(img, minX, minY, width, height) && hasManySiblings(img2, minX, minY, width, height)) ||
    (hasManySiblings(img, maxX, maxY, width, height) && hasManySiblings(img2, maxX, maxY, width, height))
  )
}

/** Flatten a PixelSource into an RGBA byte array for O(1) neighbourhood access. */
function materialize(src: PixelSource): Uint8Array {
  const { width, height } = src
  const out = new Uint8Array(width * height * 4)
  let i = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = src.pixelAt(x, y)
      out[i++] = r
      out[i++] = g
      out[i++] = b
      out[i++] = a
    }
  }
  return out
}

/** 1 where the pixel falls inside any ignore region (clamped to the image). */
function buildIgnoreMask(width: number, height: number, regions: Bounds[]): Uint8Array | undefined {
  if (regions.length === 0) return undefined
  const mask = new Uint8Array(width * height)
  for (const r of regions) {
    const x0 = Math.max(0, Math.floor(r.x))
    const y0 = Math.max(0, Math.floor(r.y))
    const x1 = Math.min(width, Math.ceil(r.x + r.width))
    const y1 = Math.min(height, Math.ceil(r.y + r.height))
    for (let y = y0; y < y1; y++) {
      mask.fill(1, y * width + x0, y * width + x1)
    }
  }
  return mask
}

/**
 * Compare two same-sized images pixel by pixel (pixelmatch semantics).
 * Different dimensions short-circuit to reason 'layout-diff' — no per-pixel pass.
 */
export function diffImages(a: PixelSource, b: PixelSource, opts: DiffOptions = {}): DiffResult {
  const threshold = opts.threshold ?? 0.1
  const ignoreAA = opts.ignoreAntialiasing ?? true
  const grid = Math.max(1, Math.floor(opts.regionGrid ?? 8))

  if (a.width !== b.width || a.height !== b.height) {
    return {
      match: false,
      reason: 'layout-diff',
      diffPixels: 0,
      totalPixels: 0,
      divergencePct: 100,
      regions: [],
    }
  }

  const width = a.width
  const height = a.height
  const img1 = materialize(a)
  const img2 = materialize(b)
  const ignored = buildIgnoreMask(width, height, opts.ignoreRegions ?? [])

  // Precomputed grid-cell lookups keep the hot loop multiplication-free.
  const colOfX = new Int32Array(width)
  for (let x = 0; x < width; x++) colOfX[x] = Math.min(grid - 1, Math.floor((x * grid) / width))
  const rowOfY = new Int32Array(height)
  for (let y = 0; y < height; y++) rowOfY[y] = Math.min(grid - 1, Math.floor((y * grid) / height))

  const cells = grid * grid
  const cellDiff = new Uint32Array(cells)
  const cellCompared = new Uint32Array(cells)
  const cellMinX = new Int32Array(cells).fill(width)
  const cellMinY = new Int32Array(cells).fill(height)
  const cellMaxX = new Int32Array(cells).fill(-1)
  const cellMaxY = new Int32Array(cells).fill(-1)

  const maxDelta = MAX_YIQ_DELTA * threshold * threshold
  const mask = new Uint8Array(width * height)
  let diffPixels = 0
  let comparedPixels = 0

  for (let y = 0; y < height; y++) {
    const row = rowOfY[y]! * grid
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      if (ignored !== undefined && ignored[idx] === 1) continue
      const cell = row + colOfX[x]!
      comparedPixels++
      cellCompared[cell]!++
      const delta = colorDelta(img1, img2, idx * 4, idx * 4, false)
      if (Math.abs(delta) <= maxDelta) continue
      if (ignoreAA && (antialiased(img1, x, y, width, height, img2) || antialiased(img2, x, y, width, height, img1))) {
        continue
      }
      mask[idx] = 1
      diffPixels++
      cellDiff[cell]!++
      if (x < cellMinX[cell]!) cellMinX[cell] = x
      if (y < cellMinY[cell]!) cellMinY[cell] = y
      if (x > cellMaxX[cell]!) cellMaxX[cell] = x
      if (y > cellMaxY[cell]!) cellMaxY[cell] = y
    }
  }

  const regions: DiffRegion[] = []
  for (let r = 0; r < grid; r++) {
    for (let c = 0; c < grid; c++) {
      const i = r * grid + c
      if (cellDiff[i] === 0) continue
      regions.push({
        grid: `r${r}c${c}`,
        bbox: {
          x: cellMinX[i]!,
          y: cellMinY[i]!,
          width: cellMaxX[i]! - cellMinX[i]! + 1,
          height: cellMaxY[i]! - cellMinY[i]! + 1,
        },
        divergencePct: (100 * cellDiff[i]!) / cellCompared[i]!,
      })
    }
  }
  regions.sort((p, q) => q.divergencePct - p.divergencePct || (p.grid < q.grid ? -1 : 1))

  return {
    match: diffPixels === 0,
    reason: diffPixels === 0 ? 'match' : 'pixel-diff',
    diffPixels,
    totalPixels: comparedPixels,
    divergencePct: comparedPixels === 0 ? 0 : (100 * diffPixels) / comparedPixels,
    regions,
    diffMask: (x: number, y: number) =>
      x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1,
  }
}
