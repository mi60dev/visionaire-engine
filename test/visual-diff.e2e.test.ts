/**
 * visual_diff e2e — real Chrome, headless, file:// fixture. Exercises the full
 * loop: record a pixel baseline via style_diff { capture_pixels }, MATCH
 * against it, mutate the box color, get DIVERGENT regions attributed to the
 * box's uid, write a decodable heatmap artifact, and hit the layout-diff /
 * REFERENCE_NOT_FOUND / BASELINE_SLOT_EMPTY error modes.
 *
 * Tests run in order and share page state (the box gets recolored twice).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findChromeExecutable, SessionManager } from '../src/session.js'
import { visualDiffTool } from '../src/tools/visual-diff.js'
import { styleDiffTool } from '../src/tools/style-diff.js'
import { annotatedScreenshotTool } from '../src/tools/annotated-screenshot.js'
import { saveBaselinePixels } from '../src/store/baselines.js'
import { encodePng } from '../src/engine/png-encode.js'
import { decodePng } from '../src/engine/png.js'
import { resolveTarget } from '../src/uid.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureUrl = (name: string): string => pathToFileURL(path.resolve(here, 'fixtures', name)).href

const chromePath = findChromeExecutable()

interface Envelope {
  verdict: 'MATCH' | 'DIVERGENT'
  summary: string
  reason: string
  divergence_pct: number
  diff_pixels: number
  total_pixels: number
  accept_pct: number
  regions: Array<{ grid: string; bbox: { x: number; y: number; width: number; height: number }; divergence_pct: number; likely_uids: string[] }>
  artifacts?: Array<{ kind: string; path: string }>
  truncated: boolean
}

describe.skipIf(!chromePath)('visual_diff e2e — real Chrome', () => {
  const session = new SessionManager()
  let scratch: string

  beforeAll(async () => {
    // Never write into the repo or shared tmp: everything lands in a scratch dir.
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'visionaire-visual-diff-'))
    process.env['VISIONAIRE_ARTIFACTS_DIR'] = path.join(scratch, 'artifacts')
    process.env['VISIONAIRE_SUITE_DIR'] = path.join(scratch, 'suites')
    process.env['VISIONAIRE_MARKER_DIR'] = path.join(scratch, 'marker')
    await session.connect({ mode: 'launch', headless: true })
    await session.navigate(fixtureUrl('visual-diff.html'))
  })

  afterAll(async () => {
    await session.disconnect()
  })

  const run = async (args: Record<string, unknown>): Promise<Envelope> =>
    JSON.parse((await visualDiffTool.handler(session.context(), args)).text) as Envelope

  const setBoxColor = async (color: string): Promise<void> => {
    const { cdp } = session.context()
    await cdp.send('Runtime.evaluate', {
      expression: `document.getElementById('box').style.background = ${JSON.stringify(color)}`,
      returnByValue: true,
    })
  }

  it("style_diff { capture_pixels } records a baseline and visual_diff reports MATCH against it", async () => {
    const rec = await styleDiffTool.handler(session.context(), {
      mode: 'record',
      selector: '#box',
      slot: 'page-base',
      capture_pixels: true,
    })
    expect(rec.text).toContain('recorded')
    expect(rec.text).toContain('pixel baseline saved')
    expect(rec.text).toContain("baseline_slot: 'page-base'")

    const env = await run({ reference: { baseline_slot: 'page-base' } })
    expect(env.verdict).toBe('MATCH')
    expect(env.reason).toBe('match')
    expect(env.diff_pixels).toBe(0)
    expect(env.divergence_pct).toBe(0)
    expect(env.total_pixels).toBeGreaterThan(0)
    expect(env.truncated).toBe(false)
  })

  it('a successful run writes the verification marker for the Stop hook', () => {
    // markVerified honors VISIONAIRE_MARKER_DIR (set in beforeAll); the previous
    // test ran visual_diff, so the marker must name it.
    const marker = path.join(scratch, 'marker', '.visionaire_verified')
    expect(fs.readFileSync(marker, 'utf8')).toBe('visual_diff\n')
  })

  it('a color change → DIVERGENT with a region whose likely_uids names the box', async () => {
    const ctx = session.context()
    const { uid: boxUid } = await resolveTarget(ctx, { selector: '#box' })
    await setBoxColor('#e53935')

    const env = await run({ reference: { baseline_slot: 'page-base' } })
    expect(env.verdict).toBe('DIVERGENT')
    expect(env.reason).toBe('pixel-diff')
    // The 120x90 box repaints entirely: 10800 px (minus nothing — solid fill).
    expect(env.diff_pixels).toBeGreaterThan(5000)
    expect(env.regions.length).toBeGreaterThan(0)
    const uids = env.regions.flatMap((r) => r.likely_uids)
    expect(uids).toContain(boxUid)
    // Region bboxes are document CSS px — they must sit inside the box rect (±1 px).
    for (const r of env.regions) {
      expect(r.bbox.x).toBeGreaterThanOrEqual(99)
      expect(r.bbox.y).toBeGreaterThanOrEqual(79)
      expect(r.bbox.x + r.bbox.width).toBeLessThanOrEqual(221)
      expect(r.bbox.y + r.bbox.height).toBeLessThanOrEqual(171)
    }
  })

  it('emit_heatmap writes a PNG artifact that exists and decodes, red where the box changed', async () => {
    const env = await run({ reference: { baseline_slot: 'page-base' }, emit_heatmap: true })
    expect(env.verdict).toBe('DIVERGENT')
    expect(env.artifacts).toBeDefined()
    const art = env.artifacts![0]!
    expect(art.kind).toBe('diff-heatmap')
    expect(art.path).toContain(scratch) // honors VISIONAIRE_ARTIFACTS_DIR
    expect(fs.existsSync(art.path)).toBe(true)
    const png = decodePng(fs.readFileSync(art.path))
    expect(png.width).toBeGreaterThan(0)
    expect(png.height).toBeGreaterThan(0)
    // Box center (100+60, 80+45) = (160,125) — dpr 1 in the launched viewport.
    expect(png.pixelAt(160, 125)).toEqual([255, 0, 0, 255])
    // Far corner is unchanged → dimmed gray, never red.
    const [r, g, b] = png.pixelAt(png.width - 5, png.height - 5)
    expect(r).toBe(g)
    expect(g).toBe(b)
  })

  it('element target: clean crop baseline → MATCH, recolor → DIVERGENT', async () => {
    const ctx = session.context()
    const shot = await annotatedScreenshotTool.handler(ctx, {
      clipTo: { selector: '#box' },
      annotate: false,
    })
    saveBaselinePixels('box-base', Buffer.from(shot.images![0]!.data, 'base64'))

    const same = await run({ target: { selector: '#box' }, reference: { baseline_slot: 'box-base' } })
    expect(same.verdict).toBe('MATCH')
    expect(same.diff_pixels).toBe(0)

    await setBoxColor('#2e7d32')
    const changed = await run({ target: { selector: '#box' }, reference: { baseline_slot: 'box-base' } })
    expect(changed.verdict).toBe('DIVERGENT')
    expect(changed.reason).toBe('pixel-diff')
    expect(changed.divergence_pct).toBeGreaterThan(50) // the whole crop is the box
  })

  it('mask_dynamic excludes the changed element and the rest of the page still matches', async () => {
    // Box is now green vs the blue page baseline — masking it hides the only difference.
    const env = await run({
      reference: { baseline_slot: 'page-base' },
      mask_dynamic: [{ selector: '#box' }],
    })
    expect(env.verdict).toBe('MATCH')
    expect(env.diff_pixels).toBe(0)
    expect(env.total_pixels).toBeLessThan(1280 * 800) // masked pixels left the denominator
    expect(env.summary).toContain('masked')
  })

  it('mask_dynamic selectors matching 0 elements are skipped and named, never fatal', async () => {
    // Vanished intermittent content (the mask_dynamic use case) must not abort the diff.
    const env = await run({
      reference: { baseline_slot: 'page-base' },
      mask_dynamic: [{ selector: '#box' }, { selector: '.ad-banner' }],
    })
    expect(env.verdict).toBe('MATCH')
    expect(env.diff_pixels).toBe(0)
    expect(env.summary).toContain('mask selector(s) matched 0 elements: .ad-banner')
  })

  it('an invalid mask_dynamic selector still throws', async () => {
    await expect(
      visualDiffTool.handler(session.context(), {
        reference: { baseline_slot: 'page-base' },
        mask_dynamic: [{ selector: ':::nope' }],
      }),
    ).rejects.toThrow(/invalid css selector/i)
  })

  it('a wrong-size image_path reference → DIVERGENT with reason layout-diff naming both dimensions', async () => {
    const tiny = path.join(scratch, 'tiny.png')
    fs.writeFileSync(tiny, encodePng(10, 10, Buffer.alloc(400, 255)))
    const env = await run({ reference: { image_path: tiny } })
    expect(env.verdict).toBe('DIVERGENT')
    expect(env.reason).toBe('layout-diff')
    expect(env.regions).toEqual([])
    expect(env.summary).toContain('LAYOUT_MISMATCH')
    expect(env.summary).toContain('10x10')
    expect(env.summary).toMatch(/\d+x\d+ px/) // capture dimensions named too
  })

  it('missing reference file → error naming REFERENCE_NOT_FOUND', async () => {
    await expect(
      visualDiffTool.handler(session.context(), { reference: { image_path: path.join(scratch, 'nope.png') } }),
    ).rejects.toThrow(/REFERENCE_NOT_FOUND/)
  })

  it('unrecorded baseline slot → error naming BASELINE_SLOT_EMPTY with the record recipe', async () => {
    await expect(
      visualDiffTool.handler(session.context(), { reference: { baseline_slot: 'ghost' } }),
    ).rejects.toThrow(/BASELINE_SLOT_EMPTY.*capture_pixels/s)
  })

  it('rejects zero or two reference sources', async () => {
    await expect(visualDiffTool.handler(session.context(), { reference: {} })).rejects.toThrow(/exactly one/)
    await expect(
      visualDiffTool.handler(session.context(), {
        reference: { image_path: '/tmp/x.png', baseline_slot: 'page-base' },
      }),
    ).rejects.toThrow(/exactly one/)
  })

  // Runs LAST: everything above assumes the launch default of deviceScaleFactor 1.
  // Empirical (real Chrome): under dsf emulation captures may come back CSS-px-sized
  // while window.devicePixelRatio reports 2, and a clipped capture permanently resets
  // the emulated dpr to 1 — visual_diff must derive its scale from the decoded image
  // and restore the emulation after element captures.
  describe('deviceScaleFactor 2 (dpr emulation)', () => {
    beforeAll(async () => {
      await session.setViewport(1280, 800, 2)
    })

    afterAll(async () => {
      await session.setViewport(1280, 800, 1)
    })

    it('page target: baseline recorded at the same dsf → MATCH', async () => {
      const rec = await styleDiffTool.handler(session.context(), {
        mode: 'record',
        selector: '#box',
        slot: 'dsf2-page',
        capture_pixels: true,
      })
      expect(rec.text).toContain('pixel baseline saved')

      const env = await run({ reference: { baseline_slot: 'dsf2-page' } })
      // Whatever dimensions Chrome returns under emulation, baseline and current must
      // decode identically (a mismatch would surface as reason layout-diff).
      expect(env.reason).toBe('match')
      expect(env.verdict).toBe('MATCH')
      expect(env.diff_pixels).toBe(0)
      expect(env.total_pixels).toBeGreaterThan(0)
    })

    it('ignore_regions given in CSS px still mask the recolored box', async () => {
      await setBoxColor('#6a1b9a')
      const unmasked = await run({ reference: { baseline_slot: 'dsf2-page' } })
      expect(unmasked.verdict).toBe('DIVERGENT')

      // A stale pre-capture dpr of 2 on a CSS-px-sized capture would place the mask at
      // (190,150)-(450,350) image px and miss the box entirely → DIVERGENT.
      const masked = await run({
        reference: { baseline_slot: 'dsf2-page' },
        ignore_regions: [{ x: 95, y: 75, width: 130, height: 100 }],
      })
      expect(masked.verdict).toBe('MATCH')
      expect(masked.diff_pixels).toBe(0)
    })

    it('element target: DIVERGENT regions attribute the box uid and dpr emulation survives', async () => {
      const ctx = session.context()
      const { uid: boxUid } = await resolveTarget(ctx, { selector: '#box' })
      const shot = await annotatedScreenshotTool.handler(ctx, {
        clipTo: { selector: '#box' },
        annotate: false,
      })
      saveBaselinePixels('dsf2-box', Buffer.from(shot.images![0]!.data, 'base64'))

      await setBoxColor('#ef6c00')
      const env = await run({ target: { selector: '#box' }, reference: { baseline_slot: 'dsf2-box' } })
      expect(env.verdict).toBe('DIVERGENT')
      expect(env.reason).toBe('pixel-diff')
      expect(env.regions.length).toBeGreaterThan(0)
      expect(env.regions.flatMap((r) => r.likely_uids)).toContain(boxUid)
      // Derived-scale back-conversion: bboxes are document CSS px inside the box rect (±1)…
      for (const r of env.regions) {
        expect(r.bbox.x).toBeGreaterThanOrEqual(99)
        expect(r.bbox.y).toBeGreaterThanOrEqual(79)
        expect(r.bbox.x + r.bbox.width).toBeLessThanOrEqual(221)
        expect(r.bbox.y + r.bbox.height).toBeLessThanOrEqual(171)
      }
      // …and reach the box's right edge (dividing image px by a stale dpr of 2 would
      // compress every region into the left half, capping x+width at ~160).
      expect(Math.max(...env.regions.map((r) => r.bbox.x + r.bbox.width))).toBeGreaterThan(200)

      // The clipped capture reset Chrome's dpr emulation; visual_diff must restore it.
      const dpr = await ctx.cdp.send('Runtime.evaluate', {
        expression: 'window.devicePixelRatio',
        returnByValue: true,
      })
      expect(dpr.result.value).toBe(2)
    })
  })
})
