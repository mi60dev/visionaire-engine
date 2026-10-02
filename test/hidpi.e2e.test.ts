/**
 * Field report: on a Retina Mac with a visible window, the page outline doubled
 * every size (DOMSnapshot rects arrive in device px while the emulated
 * deviceScaleFactor is 1) and viewport screenshots were cropped right/bottom
 * (the emulated 1920×1080 viewport was larger than the window).
 * Reproduced headless with a forced device scale and a window smaller than the viewport.
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decodePng } from '../src/engine/png.js'
import { deviceToCssScale } from '../src/engine/snapshot-scale.js'
import { findChromeExecutable, SessionManager } from '../src/session.js'
import { annotatedScreenshotTool } from '../src/tools/annotated-screenshot.js'
import { pageSnapshotTool } from '../src/tools/page-snapshot.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const chromePath = findChromeExecutable()

describe('deviceToCssScale', () => {
  it('derives the device/CSS ratio from Chrome metrics, never devicePixelRatio', () => {
    const m = (device: number, css: number) =>
      ({ contentSize: { width: device }, cssContentSize: { width: css } }) as never
    expect(deviceToCssScale(m(7680, 3840))).toBe(2)
    expect(deviceToCssScale(m(3840, 3840))).toBe(1)
    expect(deviceToCssScale(m(3841, 3840))).toBe(1)
    expect(deviceToCssScale({} as never)).toBe(1)
  })
})

describe.skipIf(!chromePath)('HiDPI window smaller than the emulated viewport', () => {
  const session = new SessionManager()
  const prevArgs = process.env['VISIONAIRE_CHROME_ARGS']

  beforeAll(async () => {
    process.env['VISIONAIRE_CHROME_ARGS'] = [prevArgs ?? '', '--force-device-scale-factor=2', '--window-size=900,700'].join(' ').trim()
    await session.connect({
      mode: 'launch',
      headless: true,
      width: 1920,
      height: 1080,
      url: pathToFileURL(path.join(here, 'fixtures', 'hidpi-stage.html')).href,
    })
  })
  afterAll(async () => {
    await session.disconnect()
    if (prevArgs === undefined) delete process.env['VISIONAIRE_CHROME_ARGS']
    else process.env['VISIONAIRE_CHROME_ARGS'] = prevArgs
  })

  it('reports CSS-pixel sizes and keeps visible rows visible', async () => {
    const snap = await pageSnapshotTool.handler(session.context(), {})
    expect(snap.text).toMatch(/div#stage 1920x1080 @\(0,0\)/)
    expect(snap.text).toMatch(/div#clock "12:00" 200x75 @\(1700,20\)/)
    expect(snap.text).not.toMatch(/off-viewport/)
  })

  it('captures the whole emulated viewport (any device scale)', async () => {
    // Headless never crops; the cropped-window case is the visible-window variant of this
    // (verified manually on a Retina Mac) and goes through the same completeness check.
    const shot = await annotatedScreenshotTool.handler(session.context(), { annotate: false })
    const png = decodePng(Buffer.from(shot.images![0]!.data, 'base64'))
    const k = png.width / 1920
    expect(png.height / 1080).toBeCloseTo(k, 2)
    // footer (magenta) bottom-left and clock (green) top-right are both in frame
    expect(png.pixelAt(Math.round(10 * k), Math.round(1070 * k)).slice(0, 3)).toEqual([255, 0, 255])
    expect(png.pixelAt(Math.round(1880 * k), Math.round(60 * k)).slice(0, 3)).toEqual([0, 255, 0])
  })
})
