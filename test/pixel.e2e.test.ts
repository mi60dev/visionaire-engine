/**
 * Pixel-perfect pack e2e: check_alignment catches the 3.5px drop and the +7px gap
 * on fixtures/pixel.html; pick_color reads the actual painted swatch color and
 * gives a WCAG contrast verdict.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SessionManager, findChromeExecutable } from '../src/session.js'
import { checkAlignmentTool } from '../src/tools/check-alignment.js'
import { pickColorTool } from '../src/tools/pick-color.js'
import type { ToolContext } from '../src/types.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureUrl = pathToFileURL(path.join(here, 'fixtures', 'pixel.html')).href
const hasChrome = !!findChromeExecutable()

describe.skipIf(!hasChrome)('pixel-perfect pack e2e', () => {
  let session: SessionManager
  let ctx: ToolContext

  beforeAll(async () => {
    session = new SessionManager()
    ctx = await session.connect({ mode: 'launch', headless: true, url: fixtureUrl })
  }, 60_000)

  afterAll(async () => {
    await session?.disconnect()
  })

  it('check_alignment flags the dropped nav item and the uneven gap', async () => {
    const res = await checkAlignmentTool.handler(ctx, { selector: '.nav a' })
    expect(res.text).toContain('4 elements (row layout)')
    expect(res.text).toMatch(/⚠ tops: 3\/4 aligned at 40\.0px — off: e\d+ at 43\.5 \(\+3\.5px\)/)
    expect(res.text).toMatch(/⚠ gaps \(horizontal\): median 24\.0px — outlier: e\d+→e\d+ = 31\.0px \(\+7\.0\)/)
    expect(res.text).toContain('widths: all 4 aligned at 80.0px ✓')
  })

  it('check_alignment grid mode reports off-grid lefts', async () => {
    const res = await checkAlignmentTool.handler(ctx, { selector: '.nav a', gridUnit: 8 })
    // 335 % 8 = 7 → -1 off the grid (nearest multiple 336)
    expect(res.text).toMatch(/⚠ off 8px grid: .*left=335\.0 \(-1\.0\)/)
  })

  it('check_alignment validates its inputs', async () => {
    await expect(checkAlignmentTool.handler(ctx, {})).rejects.toThrow(/exactly one of/i)
    await expect(checkAlignmentTool.handler(ctx, { selector: '#swatch' })).rejects.toThrow(/needs at least 2/i)
  })

  it('pick_color reads the painted swatch background and passes AA', async () => {
    const res = await pickColorTool.handler(ctx, { selector: '#swatch', at: 'top-left' })
    expect(res.text).toContain('painted pixel: rgb(108,92,231) #6c5ce7')
    expect(res.text).toContain('computed: color rgb(255, 255, 255) | background-color rgb(108, 92, 231)')
    expect(res.text).toMatch(/contrast .*: 4\.\d+:1 — AA normal ✓, AAA ✗/)
  })

  it('pick_color works from raw coordinates too', async () => {
    // Inside the swatch (left 16..136, top 200..260): sample (30, 210).
    const res = await pickColorTool.handler(ctx, { x: 30, y: 210 })
    expect(res.text).toContain('painted pixel: rgb(108,92,231) #6c5ce7')
  })
})
