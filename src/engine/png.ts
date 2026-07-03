/**
 * Minimal PNG decoder for pixel sampling — dependency-free (node:zlib only).
 * Supports what Chrome's Page.captureScreenshot emits: 8-bit RGB/RGBA,
 * non-interlaced. Enough to read the ACTUAL painted color of a pixel, which
 * computed styles cannot give (gradients, images, opacity stacks, blends).
 */
import zlib from 'node:zlib'

export interface DecodedPng {
  width: number
  height: number
  pixelAt(x: number, y: number): [number, number, number, number]
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function decodePng(buf: Buffer): DecodedPng {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG')
  let off = 8
  let width = 0
  let height = 0
  let colorType = 6
  const idat: Buffer[] = []
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('latin1', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const bitDepth = data[8]!
      colorType = data[9]!
      const interlace = data[12]!
      if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0) {
        throw new Error(`unsupported PNG (bitDepth ${bitDepth}, colorType ${colorType}, interlace ${interlace})`)
      }
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    off += 12 + len
  }
  if (width === 0 || height === 0 || idat.length === 0) throw new Error('malformed PNG')

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const bpp = colorType === 6 ? 4 : 3
  const stride = width * bpp
  const out = Buffer.alloc(height * stride)
  let pos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]!
    const row = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : undefined
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[pos++]!
      const left = x >= bpp ? row[x - bpp]! : 0
      const up = prev ? prev[x]! : 0
      const upLeft = prev && x >= bpp ? prev[x - bpp]! : 0
      let val: number
      switch (filter) {
        case 0:
          val = rawByte
          break
        case 1:
          val = rawByte + left
          break
        case 2:
          val = rawByte + up
          break
        case 3:
          val = rawByte + ((left + up) >> 1)
          break
        case 4: {
          // Paeth predictor
          const p = left + up - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - upLeft)
          val = rawByte + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)
          break
        }
        default:
          throw new Error(`bad PNG filter ${filter}`)
      }
      row[x] = val & 0xff
    }
  }

  return {
    width,
    height,
    pixelAt(x, y) {
      if (x < 0 || y < 0 || x >= width || y >= height) throw new Error(`pixel (${x},${y}) out of bounds`)
      const i = y * stride + x * bpp
      return [out[i]!, out[i + 1]!, out[i + 2]!, bpp === 4 ? out[i + 3]! : 255]
    },
  }
}
