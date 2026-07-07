/**
 * Minimal PNG encoder for diff heatmaps — dependency-free (node:zlib only),
 * mirroring the decoder in png.ts. Emits exactly what visual_diff needs:
 * 8-bit RGBA, non-interlaced, every scanline filter 0 (None), one IDAT chunk
 * from zlib.deflateSync. Deterministic: same pixels → same bytes.
 */
import zlib from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Standard CRC-32 (reflected, polynomial 0xEDB88320) lookup table. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(...bufs: Buffer[]): number {
  let c = 0xffffffff
  for (const buf of bufs) {
    for (let i = 0; i < buf.length; i++) {
      c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
    }
  }
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'latin1')
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length, 0)
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(typeBuf, data), 0)
  return Buffer.concat([head, typeBuf, data, tail])
}

/** Encode a flat RGBA buffer (width·height·4 bytes, top-left origin) as a PNG. */
export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`invalid PNG dimensions ${width}x${height} — width and height must be positive integers`)
  }
  const expected = width * height * 4
  if (rgba.length !== expected) {
    throw new Error(`rgba buffer is ${rgba.length} bytes — expected width*height*4 = ${expected} for ${width}x${height}`)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0 // compression: deflate
  ihdr[11] = 0 // filter method: adaptive (per-row byte below)
  ihdr[12] = 0 // interlace: none

  // Each scanline prefixed with filter byte 0 (None) — simple beats small here.
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const idat = zlib.deflateSync(raw)

  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}
