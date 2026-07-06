/**
 * annotated_screenshot e2e — real Chrome, headless, file:// fixture. Covers the
 * v0.4 element-scoped additions (clipTo / padding / scale / annotate) alongside
 * the original whole-viewport marked mode.
 *
 * Empirical contract this tool relies on (verified in a scratch probe against
 * headless Chrome, and re-asserted here so a Chrome update fails loudly):
 *   - DOM.getBoxModel returns VIEWPORT-relative quads.
 *   - Page.captureScreenshot({ clip, captureBeyondViewport:true }) reads the clip
 *     in DOCUMENT coords, so box coords get the scroll offset added.
 *   - clip.scale multiplies the output image's pixel dimensions.
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findChromeExecutable, SessionManager } from '../src/session.js'
import { annotatedScreenshotTool } from '../src/tools/annotated-screenshot.js'
import { resolveTarget } from '../src/uid.js'
import type { ToolResult } from '../src/types.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureUrl = (name: string): string => pathToFileURL(path.resolve(here, 'fixtures', name)).href

const chromePath = findChromeExecutable()

/** A PNG's intrinsic pixel dimensions from its IHDR chunk (bytes 16–23, big-endian). */
function pngSize(base64: string): { width: number; height: number } {
  const buf = Buffer.from(base64, 'base64')
  // PNG signature (8) + IHDR length (4) + "IHDR" (4) = width at offset 16, height at 20.
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function onlyImage(res: ToolResult): { data: string; mimeType: string } {
  expect(res.images).toBeDefined()
  expect(res.images).toHaveLength(1)
  const img = res.images![0]!
  expect(img.mimeType).toBe('image/png')
  expect(img.data.length).toBeGreaterThan(0)
  return img
}

describe.skipIf(!chromePath)('annotated_screenshot e2e — real Chrome', () => {
  const session = new SessionManager()

  beforeAll(async () => {
    await session.connect({ mode: 'launch', headless: true })
    await session.navigate(fixtureUrl('cascade.html'))
  })

  afterAll(async () => {
    await session.disconnect()
  })

  const run = (args: Record<string, unknown>): Promise<ToolResult> =>
    annotatedScreenshotTool.handler(session.context(), args)

  it('still marks the whole viewport by default (backward compatible)', async () => {
    const res = await run({})
    onlyImage(res)
    expect(res.text).toMatch(/^annotated screenshot \(viewport\)/)
    expect(res.text).toContain('mark number = uid digits')
    // The fixture has several interactive/landmark elements, so at least one mark.
    expect(res.text).toContain('marks:')
  })

  it('annotate:false without clipTo returns a clean whole-viewport shot (no marks, no noise)', async () => {
    const res = await run({ annotate: false })
    onlyImage(res)
    expect(res.text).toMatch(/^annotated screenshot \(viewport\)/)
    expect(res.text).not.toContain('marks:')
    expect(res.text).not.toContain('no markable elements found')
    const ctx = session.context()
    const leftover = await ctx.cdp.send('Runtime.evaluate', {
      expression: 'document.querySelectorAll("[data-visionaire-overlay]").length',
      returnByValue: true,
    })
    expect(leftover.result.value).toBe(0)
  })

  it('clipTo a selector returns an image and a caption naming the element + crop rect', async () => {
    const res = await run({ clipTo: { selector: '#promo-banner' } })
    onlyImage(res)
    // Caption identifies the element (id burned into identityOf) and gives a doc-px crop rect.
    expect(res.text).toMatch(/^element screenshot <div#promo-banner/)
    expect(res.text).toMatch(/crop \d+x\d+ @\(\d+,\d+\) doc px/)
    // No overview legend on the element-scoped path.
    expect(res.text).not.toContain('mark number = uid digits')
    expect(res.text).not.toContain('marks:')
  })

  it('clipTo combined with fullPage/region succeeds via precedence + teaching note (no error round-trip)', async () => {
    // Field report: an agent passed clipTo together with fullPage and got a hard
    // "mutually exclusive" error. Intent is obvious — resolve it, note it, move on.
    const res = await run({ clipTo: { selector: '#promo-banner' }, fullPage: true, region: { x: 0, y: 0, width: 10, height: 10 } })
    onlyImage(res)
    expect(res.text).toMatch(/^element screenshot <div#promo-banner/)
    expect(res.text).toMatch(/note: region and fullPage ignored — clipTo is the capture mode/)
  })

  it('region + fullPage resolves to region with a note', async () => {
    const res = await run({ region: { x: 0, y: 0, width: 100, height: 100 }, fullPage: true })
    onlyImage(res)
    expect(res.text).toContain('region 100x100')
    expect(res.text).toMatch(/note: fullPage ignored — region is more specific/)
  })

  it('clipTo a uid works (the uid idiom, not just selectors)', async () => {
    // Resolve #promo-banner to a real uid the way page_snapshot would, then clip by it.
    const { uid } = await resolveTarget(session.context(), { selector: '#promo-banner' })
    expect(uid).toMatch(/^e\d+$/)
    const res = await run({ clipTo: { uid } })
    onlyImage(res)
    expect(res.text).toMatch(/^element screenshot <div#promo-banner/)
  })

  it('annotate:false burns in no marks/labels — a clean crop with no legend text', async () => {
    const res = await run({ clipTo: { selector: '#promo-banner' }, annotate: false })
    onlyImage(res)
    expect(res.text).toContain('clean crop, no marks')
    expect(res.text).not.toContain('marks:')
    expect(res.text).not.toContain('mark number = uid digits')
    // The overlay is never injected on a clean crop — confirm no marker survives in the DOM.
    const ctx = session.context()
    const leftover = await ctx.cdp.send('Runtime.evaluate', {
      expression: 'document.querySelectorAll("[data-visionaire-overlay]").length',
      returnByValue: true,
    })
    expect(leftover.result.value).toBe(0)
  })

  it('scale:2 produces a larger image than scale:1 for the same element', async () => {
    const one = await run({ clipTo: { selector: '#promo-banner' }, scale: 1 })
    const two = await run({ clipTo: { selector: '#promo-banner' }, scale: 2 })
    const s1 = pngSize(onlyImage(one).data)
    const s2 = pngSize(onlyImage(two).data)
    // Roughly double the pixel dimensions (allow rounding slack).
    expect(s2.width).toBeGreaterThan(s1.width)
    expect(s2.height).toBeGreaterThan(s1.height)
    expect(s2.width).toBeGreaterThanOrEqual(s1.width * 2 - 2)
    expect(s2.width).toBeLessThanOrEqual(s1.width * 2 + 2)
    // Caption reflects the zoom.
    expect(two.text).toContain('@2x')
    expect(one.text).not.toContain('@1x')
  })

  it('scale clamps out-of-range values to 0.5..4', async () => {
    const huge = await run({ clipTo: { selector: '#promo-banner' }, scale: 99 })
    const base = await run({ clipTo: { selector: '#promo-banner' }, scale: 1 })
    const hSize = pngSize(onlyImage(huge).data)
    const bSize = pngSize(onlyImage(base).data)
    // 99 clamps to 4×, not 99×.
    expect(huge.text).toContain('@4x')
    expect(hSize.width).toBeLessThanOrEqual(bSize.width * 4 + 2)
    expect(hSize.width).toBeGreaterThanOrEqual(bSize.width * 4 - 2)
  })

  it('padding enlarges the crop rectangle around the element', async () => {
    const tight = await run({ clipTo: { selector: '#promo-banner' }, padding: 0 })
    const padded = await run({ clipTo: { selector: '#promo-banner' }, padding: 20 })
    const t = pngSize(onlyImage(tight).data)
    const p = pngSize(onlyImage(padded).data)
    // 20px each side at scale 1 → +40px in each dimension.
    expect(p.width).toBe(t.width + 40)
    expect(p.height).toBe(t.height + 40)
    expect(padded.text).toContain('+20px padding')
  })

  it('adds the scroll offset so a scrolled element still crops correctly (viewport→document coords)', async () => {
    const ctx = session.context()
    // Give the page room to scroll and push the banner off the initial viewport.
    await ctx.cdp.send('Runtime.evaluate', {
      expression: 'document.body.style.paddingTop = "3000px"; window.scrollTo(0, 2500)',
      returnByValue: true,
    })
    try {
      const scrolled = await run({ clipTo: { selector: '#promo-banner' } })
      onlyImage(scrolled)
      const s = pngSize(scrolled.images![0]!.data)
      // A correct doc-coord clip yields the element's own size; a missing scroll offset
      // would clip empty space (Chrome clamps such a clip, giving a different/blank crop).
      expect(s.width).toBeGreaterThan(0)
      expect(s.height).toBeGreaterThan(0)
      // Reset scroll and re-capture: same element, same pixels ⇒ the offset math is right.
      await ctx.cdp.send('Runtime.evaluate', {
        expression: 'window.scrollTo(0, 0)',
        returnByValue: true,
      })
      const atTop = await run({ clipTo: { selector: '#promo-banner' } })
      const t = pngSize(atTop.images![0]!.data)
      expect(t).toEqual(s)
      expect(atTop.images![0]!.data).toBe(scrolled.images![0]!.data)
    } finally {
      await ctx.cdp.send('Runtime.evaluate', {
        expression: 'document.body.style.paddingTop = ""; window.scrollTo(0, 0)',
        returnByValue: true,
      })
    }
  })

  it('errors helpfully when clipTo points at a non-rendered element', async () => {
    // .hidden-action is display:none in the fixture — no layout box to clip to.
    await expect(run({ clipTo: { selector: '.hidden-action' } })).rejects.toThrow(/no layout box/i)
  })


  it('rejects an unknown clipTo uid with an actionable message', async () => {
    await expect(run({ clipTo: { uid: 'e9999' } })).rejects.toThrow(/page_snapshot/)
  })
})
