/**
 * Viewport screenshots that always cover the EMULATED viewport.
 *
 * A plain Page.captureScreenshot grabs the window's real surface. When the
 * emulated viewport is larger than the visible window (launch mode asks for
 * 1920×1080 on a laptop screen that can only fit ~1200×870), the image comes
 * back cropped on the right and bottom (field report). With an emulated
 * viewport we therefore capture an explicit viewport-sized clip beyond the
 * window surface. Empirically such a clipped capture resets an emulated
 * deviceScaleFactor to 1, so the override is re-asserted afterwards (same
 * remedy as visual_diff). Without emulation (extension / attach sessions in
 * the user's own window) the window IS the viewport: plain capture.
 */
import type { Protocol } from 'puppeteer-core'
import type { ToolContext } from '../types.js'
import { deviceToCssScale } from './snapshot-scale.js'

/** Clip params for the current emulated viewport, or undefined when nothing is emulated. */
export async function emulatedViewportClip(
  ctx: ToolContext,
): Promise<Pick<Protocol.Page.CaptureScreenshotRequest, 'clip' | 'captureBeyondViewport'> | undefined> {
  if (!ctx.page.viewport()) return undefined
  const m = await ctx.cdp.send('Page.getLayoutMetrics')
  const v = m.cssVisualViewport
  const l = m.cssLayoutViewport
  const width = v?.clientWidth ?? l?.clientWidth
  const height = v?.clientHeight ?? l?.clientHeight
  if (!width || !height) return undefined
  // A HiDPI window renders the clip at its physical ratio; scale it back so the image is
  // CSS-px sized, as in headless (smaller images, identical downstream geometry).
  const scale = 1 / deviceToCssScale(m)
  return {
    clip: { x: v?.pageX ?? l?.pageX ?? 0, y: v?.pageY ?? l?.pageY ?? 0, width, height, scale },
    captureBeyondViewport: true,
  }
}

/** Re-assert an emulated devicePixelRatio that a clipped capture may have reset. */
export async function restoreEmulatedDpr(ctx: ToolContext): Promise<void> {
  const vp = ctx.page.viewport()
  if (!vp?.deviceScaleFactor || vp.deviceScaleFactor === 1) return
  await ctx.cdp
    .send('Emulation.setDeviceMetricsOverride', {
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: vp.deviceScaleFactor,
      mobile: vp.isMobile ?? false,
    })
    .catch(() => {})
}

/** PNG width/height straight from the IHDR chunk (no full decode). */
function pngSize(base64: string): { width: number; height: number } | undefined {
  const head = Buffer.from(base64.slice(0, 64), 'base64')
  if (head.length < 24 || head.toString('ascii', 12, 16) !== 'IHDR') return undefined
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
}

/**
 * Viewport screenshot with crop detection: take the normal capture, and only if it
 * is smaller than the viewport at the window's device ratio (the window is smaller
 * than the emulated viewport) re-capture with an explicit viewport clip. Every case
 * that already worked keeps its exact previous output.
 */
export async function captureViewportShot(
  ctx: ToolContext,
  params: Protocol.Page.CaptureScreenshotRequest = { format: 'png' },
): Promise<Protocol.Page.CaptureScreenshotResponse> {
  const plain = await ctx.cdp.send('Page.captureScreenshot', params)
  if (!ctx.page.viewport() || params.clip) return plain
  const m = await ctx.cdp.send('Page.getLayoutMetrics')
  const v = m.cssVisualViewport ?? m.cssLayoutViewport
  const size = pngSize(plain.data)
  if (!v || !size) return plain
  const r = deviceToCssScale(m)
  const complete = Math.abs(size.width - v.clientWidth * r) <= 2 && Math.abs(size.height - v.clientHeight * r) <= 2
  if (complete) return plain
  const clip = await emulatedViewportClip(ctx)
  if (!clip) return plain
  try {
    return await ctx.cdp.send('Page.captureScreenshot', { ...params, ...clip })
  } finally {
    await restoreEmulatedDpr(ctx)
  }
}

/** Base64 PNG of exactly the viewport. */
export async function captureViewport(ctx: ToolContext): Promise<string> {
  return (await captureViewportShot(ctx)).data
}
