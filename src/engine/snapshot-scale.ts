/**
 * DOMSnapshot.captureSnapshot reports layout bounds in DEVICE pixels when the
 * window's real device scale differs from the emulated one — e.g. a visible
 * (headful) Chrome on a Retina display with the emulated deviceScaleFactor 1:
 * every rect comes back ×2, while the page, getBoundingClientRect and
 * Page.getLayoutMetrics' css* fields all speak CSS pixels (verified on macOS,
 * Chrome 154: contentSize 7680 vs cssContentSize 3840). Headless, they agree.
 *
 * The factor is derived from Chrome's own pair of numbers, never from
 * window.devicePixelRatio (which reports the EMULATED ratio, 1, here).
 */
import type { Protocol } from 'puppeteer-core'
import type { ToolContext } from '../types.js'

export function deviceToCssScale(metrics: Protocol.Page.GetLayoutMetricsResponse): number {
  const pairs: Array<[number | undefined, number | undefined]> = [
    [metrics.contentSize?.width, metrics.cssContentSize?.width],
    [metrics.layoutViewport?.clientWidth, metrics.cssLayoutViewport?.clientWidth],
  ]
  for (const [device, css] of pairs) {
    if (device && css && device > 0 && css > 0) {
      const s = device / css
      return Math.abs(s - 1) < 0.01 ? 1 : s
    }
  }
  return 1
}

export async function snapshotScale(ctx: ToolContext): Promise<number> {
  try {
    return deviceToCssScale(await ctx.cdp.send('Page.getLayoutMetrics'))
  } catch {
    return 1
  }
}

/** Bounds row → CSS-pixel rect. */
export function cssBounds(r: number[] | undefined, scale: number): { x: number; y: number; width: number; height: number } | undefined {
  if (!r || r.length < 4) return undefined
  return { x: r[0]! / scale, y: r[1]! / scale, width: r[2]! / scale, height: r[3]! / scale }
}
