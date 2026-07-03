/**
 * Pure units for the pixel-perfect pack: alignment analysis, color math, PNG decode.
 */
import { describe, it, expect } from 'vitest'
import zlib from 'node:zlib'
import { analyzeAlignment, type AlignBox } from '../src/engine/alignment.js'
import { contrastRatio, contrastVerdict, parseCssColor, relativeLuminance, toHex } from '../src/engine/color.js'
import { decodePng } from '../src/engine/png.js'

const box = (uid: string, x: number, y: number, w = 80, h = 40): AlignBox => ({
  uid,
  identity: `<div>`,
  x,
  y,
  w,
  h,
})

describe('analyzeAlignment', () => {
  it('reports a clean row as all-aligned with even gaps', () => {
    const boxes = [box('e1', 0, 100), box('e2', 104, 100), box('e3', 208, 100), box('e4', 312, 100)]
    const lines = analyzeAlignment(boxes).join('\n')
    expect(lines).toContain('row layout')
    expect(lines).toContain('tops: all 4 aligned at 100.0px ✓')
    expect(lines).toContain('gaps (horizontal): all 3 ≈ 24.0px ✓')
    expect(lines).not.toContain('⚠')
  })

  it('flags the one element that sits lower', () => {
    const boxes = [box('e1', 0, 100), box('e2', 104, 100), box('e3', 208, 103.5), box('e4', 312, 100)]
    const lines = analyzeAlignment(boxes).join('\n')
    expect(lines).toMatch(/⚠ tops: 3\/4 aligned at 100\.0px — off: e3 at 103\.5 \(\+3\.5px\)/)
  })

  it('flags a gap-rhythm outlier with its delta', () => {
    const boxes = [box('e1', 0, 100), box('e2', 104, 100), box('e3', 215, 100), box('e4', 319, 100)]
    const lines = analyzeAlignment(boxes).join('\n')
    expect(lines).toMatch(/⚠ gaps \(horizontal\): median 24\.0px — outlier: e2→e3 = 31\.0px \(\+7\.0\)/)
  })

  it('detects column layout and vertical gaps', () => {
    const boxes = [box('e1', 50, 0), box('e2', 50, 64), box('e3', 50, 128)]
    const lines = analyzeAlignment(boxes).join('\n')
    expect(lines).toContain('column layout')
    expect(lines).toContain('lefts: all 3 aligned at 50.0px ✓')
    expect(lines).toContain('gaps (vertical): all 2 ≈ 24.0px ✓')
  })

  it('checks grid conformance when gridUnit is given', () => {
    const boxes = [box('e1', 8, 16), box('e2', 96, 16), box('e3', 189, 16)]
    const lines = analyzeAlignment(boxes, { gridUnit: 8 }).join('\n')
    // 189 sits 3px BELOW the nearest multiple (192) — reported signed toward it.
    expect(lines).toMatch(/⚠ off 8px grid: e3\.left=189\.0 \(-3\.0\)/)
  })

  it('flags fractional device pixels (pixel snap) honoring dpr', () => {
    const boxes = [box('e1', 10.5, 100), box('e2', 104, 100)]
    expect(analyzeAlignment(boxes, { dpr: 1 }).join('\n')).toMatch(/⚠ pixel snap .*e1 x=10\.5/)
    // at dpr 2, 10.5 CSS px = 21 device px — perfectly snapped
    expect(analyzeAlignment(boxes, { dpr: 2 }).join('\n')).not.toContain('pixel snap')
  })
})

describe('color math', () => {
  it('parses rgb/rgba/hex forms', () => {
    expect(parseCssColor('rgb(108, 92, 231)')).toEqual([108, 92, 231, 1])
    expect(parseCssColor('rgba(0,0,0,0.5)')).toEqual([0, 0, 0, 0.5])
    expect(parseCssColor('#6c5ce7')).toEqual([108, 92, 231, 1])
    expect(parseCssColor('#fff')).toEqual([255, 255, 255, 1])
    expect(parseCssColor('currentcolor')).toBeUndefined()
  })

  it('computes WCAG luminance and the canonical 21:1 black/white ratio', () => {
    expect(relativeLuminance([255, 255, 255, 1])).toBeCloseTo(1, 5)
    expect(relativeLuminance([0, 0, 0, 1])).toBeCloseTo(0, 5)
    expect(contrastRatio([0, 0, 0, 1], [255, 255, 255, 1])).toBeCloseTo(21, 1)
  })

  it('renders verdicts at the AA/AAA boundaries', () => {
    expect(contrastVerdict(21)).toContain('AA normal ✓')
    expect(contrastVerdict(21)).toContain('AAA ✓')
    expect(contrastVerdict(4.6)).toContain('AA normal ✓')
    expect(contrastVerdict(4.6)).toContain('AAA ✗')
    expect(contrastVerdict(2.1)).toContain('AA ✗')
  })

  it('round-trips hex', () => {
    expect(toHex([108, 92, 231, 1])).toBe('#6c5ce7')
  })
})

describe('decodePng', () => {
  /** Hand-build a 2x1 RGBA PNG: red pixel then blue pixel, filter 0. */
  function tinyPng(): Buffer {
    const chunk = (type: string, data: Buffer): Buffer => {
      const len = Buffer.alloc(4)
      len.writeUInt32BE(data.length)
      const typeBuf = Buffer.from(type, 'latin1')
      const crcInput = Buffer.concat([typeBuf, data])
      // CRC over type+data (zlib.crc32 available in modern Node)
      const crc = Buffer.alloc(4)
      crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(crcInput) >>> 0 : 0)
      return Buffer.concat([len, typeBuf, data, crc])
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(2, 0) // width
    ihdr.writeUInt32BE(1, 4) // height
    ihdr[8] = 8 // bit depth
    ihdr[9] = 6 // RGBA
    const scanline = Buffer.from([0, 255, 0, 0, 255, 0, 0, 255, 255]) // filter0 + red + blue
    const idat = zlib.deflateSync(scanline)
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', idat),
      chunk('IEND', Buffer.alloc(0)),
    ])
  }

  it('decodes pixels from a handcrafted PNG', () => {
    const png = decodePng(tinyPng())
    expect(png.width).toBe(2)
    expect(png.height).toBe(1)
    expect(png.pixelAt(0, 0)).toEqual([255, 0, 0, 255])
    expect(png.pixelAt(1, 0)).toEqual([0, 0, 255, 255])
  })

  it('rejects non-PNG input', () => {
    expect(() => decodePng(Buffer.from('nope'))).toThrow(/not a PNG/)
  })
})
