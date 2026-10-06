/**
 * Field report 2026-10-06 in real headless Chrome: navigate waits for an SPA route,
 * read_text returns full table text, interact scrolls a below-the-fold Cancel into view
 * and reports the dialog closing, and a 28,000 px full-page screenshot stays returnable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SessionManager, findChromeExecutable } from '../src/session.js'
import { readTextTool } from '../src/tools/read-text.js'
import { interactTool } from '../src/tools/interact.js'
import { annotatedScreenshotTool } from '../src/tools/annotated-screenshot.js'
import { SHOT_MAX_BASE64 } from '../src/engine/capture.js'
import type { ToolContext } from '../src/types.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const incidentUrl = pathToFileURL(path.join(here, 'fixtures', 'incident.html')).href
const tallUrl = pathToFileURL(path.join(here, 'fixtures', 'tall.html')).href
const hasChrome = !!findChromeExecutable()

describe.skipIf(!hasChrome)('incident 2026-10-06 e2e', () => {
  let session: SessionManager
  let ctx: ToolContext

  beforeAll(async () => {
    session = new SessionManager()
    ctx = (await session.connect({ mode: 'launch', headless: true }))!
  }, 60_000)

  afterAll(async () => {
    await session?.disconnect()
  })

  it('navigate without settle returns while the route still says Loading...', async () => {
    const settled = await session.navigate(incidentUrl, { timeoutMs: 0 })
    expect(settled?.note).toMatch(/skipped/)
    const text = await ctx.page.evaluate(() => document.getElementById('app')!.textContent)
    expect(text).toBe('Loading...')
  })

  it('navigate waits for the SPA route to render (default settle)', async () => {
    const settled = await session.navigate(incidentUrl)
    expect(settled?.settled).toBe(true)
    expect(await ctx.page.$('#data')).not.toBeNull()
  })

  it('navigate with waitFor reports the selector appearing', async () => {
    const settled = await session.navigate(incidentUrl, { selector: '#data tbody tr' })
    expect(settled?.note).toMatch(/"#data tbody tr" appeared after \d+ms/)
  })

  it('navigate with a selector that never appears says so instead of hanging', async () => {
    const settled = await session.navigate(incidentUrl, { selector: '#never', timeoutMs: 1000 })
    expect(settled?.settled).toBe(false)
    expect(settled?.note).toMatch(/did NOT appear within 1000ms/)
  })

  it('read_text returns the full cell text, rows on lines, cells tab-separated', async () => {
    await session.navigate(incidentUrl, { selector: '#data' })
    const res = await readTextTool.handler(ctx, { selector: '#data' })
    expect(res.text).toContain('Homepage hero banner above the fold on mobile Safari\tPixel difference with a 2 percent threshold')
    expect(res.text).toContain('Checkout summary panel\tLayout shift only')
    expect(res.text).not.toContain('truncated')
  })

  it('read_text marks truncation', async () => {
    const res = await readTextTool.handler(ctx, { selector: '#data', maxChars: 80 })
    expect(res.text).toMatch(/\[… truncated \d+ more chars/)
  })

  it('interact reports the dialog opening, then a below-the-fold Cancel closing it', async () => {
    const opened = await interactTool.handler(ctx, { selector: '#open' })
    expect(opened.text).toContain('dialog opened: "New report"')
    const closed = await interactTool.handler(ctx, { selector: '#cancel' })
    expect(closed.text).toContain('dialog closed: "New report"')
    expect(await ctx.page.evaluate(() => (document.getElementById('dlg') as HTMLDialogElement).open)).toBe(false)
  })

  it('a 28,000 px full-page screenshot is downscaled to a returnable image', async () => {
    await session.navigate(tallUrl)
    const res = await annotatedScreenshotTool.handler(ctx, { fullPage: true, annotate: false })
    expect(res.text).toMatch(/image downscaled to 0\.\d+x/)
    const img = res.images![0]!
    expect(img.data.length).toBeLessThanOrEqual(SHOT_MAX_BASE64)
    const height = Buffer.from(img.data, 'base64').readUInt32BE(20)
    expect(height).toBeLessThanOrEqual(7_800)
  }, 60_000)
})
