/**
 * visual_diff — pixel-level "does it still look right?" (v-next SPEC §3C).
 * Captures the current viewport (or one element's clean crop) and diffs it
 * against a reference PNG or a recorded baseline slot using the pure
 * pixelmatch-port engine. Divergent grid regions are mapped back to element
 * uids via the DOMSnapshot paint index so the caller learns WHICH element
 * changed, not just that pixels did.
 *
 * Coordinate spaces: the diff runs in image (device) pixels; region bboxes are
 * converted back to DOCUMENT CSS px (÷ capture scale, + capture origin) for
 * uid attribution and for the envelope. ignore_regions arrive in CSS px
 * relative to the captured area's top-left and are converted the other way.
 * The capture scale is DERIVED from the decoded image (image px ÷ captured
 * area CSS px), never read from window.devicePixelRatio: under devtools dpr
 * emulation Chrome returns CSS-px-sized screenshots while devicePixelRatio
 * still reports the emulated value (verified in real Chrome).
 */
import fs from 'node:fs'
import { z } from 'zod'
import type { Bounds, ResolvedNode, ToolContext, ToolDef, ToolResult } from '../types.js'
import { resolveTarget } from '../uid.js'
import { decodePng, type DecodedPng } from '../engine/png.js'
import { encodePng } from '../engine/png-encode.js'
import { diffImages, type DiffRegion } from '../engine/pixel-diff.js'
import { buildPaintIndex, resolveAssertTarget, TargetResolutionError } from '../engine/assert-collect.js'
import { annotatedScreenshotTool } from './annotated-screenshot.js'
import { loadBaselinePixels } from '../store/baselines.js'
import { artifactPath } from '../store/artifacts.js'
import { markVerified } from '../store/verify-marker.js'

/** Keep the envelope comfortably under the ~15KB transport floor (v-next SPEC §7). */
const MAX_RESPONSE_BYTES = Math.max(4_000, Number(process.env['VISIONAIRE_MAX_RESPONSE_KB']) * 1024 || 15_000)
/** Memory guard: reject captures/references beyond 32M pixels (≈128MB RGBA each). */
const MAX_PIXELS = 33_554_432
/** Grid cells at or below this divergence are noise, not regions worth reporting. */
const NOISE_FLOOR_PCT = 0.5
/** Hard cap on reported regions (before the byte-budget backstop). */
const MAX_REGIONS = 20
/** Per divergent region, at most this many likely uids from the paint index. */
const MAX_UIDS_PER_REGION = 3

const inputSchema = {
  target: z
    .union([
      z.literal('page').describe('Compare the whole current viewport'),
      z.object({
        uid: z.string().optional().describe('Element uid from a prior page_snapshot / find_elements'),
        selector: z.string().optional().describe('CSS selector (first match) — alternative to uid'),
      }),
    ])
    .default('page')
    .describe("What to capture: 'page' (viewport, default) or one element { uid | selector } as a clean border-box crop"),
  reference: z
    .object({
      image_path: z.string().optional().describe('Path to a PNG file to compare against'),
      baseline_slot: z
        .string()
        .optional()
        .describe("Pixel baseline recorded via style_diff { mode: 'record', capture_pixels: true }"),
    })
    .describe('What to compare against — exactly ONE of image_path | baseline_slot'),
  threshold: z
    .number()
    .min(0)
    .max(1)
    .default(0.1)
    .describe('Per-pixel YIQ color-distance threshold 0..1 (pixelmatch semantics; smaller = stricter). Default 0.1'),
  accept_pct: z
    .number()
    .min(0)
    .max(100)
    .default(0.1)
    .describe('The verdict line: MATCH when divergence_pct (percent of compared pixels that differ) <= accept_pct. Default 0.1'),
  ignore_antialiasing: z
    .boolean()
    .default(true)
    .describe('Dismiss pixels that look like font/edge anti-aliasing (pixelmatch heuristic). Default true'),
  ignore_regions: z
    .array(
      z.object({
        x: z.number().describe('Left, CSS px from the captured area left edge'),
        y: z.number().describe('Top, CSS px from the captured area top edge'),
        width: z.number().positive().describe('Width in CSS px'),
        height: z.number().positive().describe('Height in CSS px'),
      }),
    )
    .default([])
    .describe("Rectangles to exclude, CSS px relative to the captured area's top-left (viewport for 'page', element box for element targets)"),
  mask_dynamic: z
    .array(
      z.union([
        z.string().describe('Element uid'),
        z.object({ selector: z.string() }).describe('CSS selector — expands to ALL matches'),
      ]),
    )
    .default([])
    .describe('Elements whose current border boxes are excluded from the diff — timestamps, ads, carousels'),
  emit_heatmap: z
    .boolean()
    .default(false)
    .describe('Write a diff heatmap PNG (dimmed capture, differing pixels in red) and return its path in artifacts'),
  region_grid: z
    .number()
    .int()
    .min(1)
    .max(16)
    .default(8)
    .describe('Report divergence per NxN grid over the capture. Default 8'),
}

const argsSchema = z.object(inputSchema)

interface EnvelopeRegion {
  grid: string
  /** Document CSS px (rounded) — feed straight into inspect_element / annotated_screenshot. */
  bbox: Bounds
  divergence_pct: number
  likely_uids: string[]
}

interface Envelope {
  verdict: 'MATCH' | 'DIVERGENT'
  summary: string
  reason: 'match' | 'pixel-diff' | 'layout-diff'
  divergence_pct: number
  diff_pixels: number
  total_pixels: number
  accept_pct: number
  regions: EnvelopeRegion[]
  artifacts?: Array<{ kind: string; path: string }>
  truncated: boolean
}

interface PageInfo {
  scrollX: number
  scrollY: number
  /** Layout viewport in CSS px (documentElement.clientWidth/Height) — the page-capture scale denominator. */
  cssWidth: number
  cssHeight: number
}

async function pageInfo(ctx: ToolContext): Promise<PageInfo> {
  const res = await ctx.cdp.send('Runtime.evaluate', {
    expression:
      '({ sx: window.scrollX, sy: window.scrollY, vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight })',
    returnByValue: true,
  })
  const v = (res.result.value ?? {}) as { sx?: number; sy?: number; vw?: number; vh?: number }
  return { scrollX: v.sx ?? 0, scrollY: v.sy ?? 0, cssWidth: v.vw ?? 0, cssHeight: v.vh ?? 0 }
}

/**
 * Device-px-per-CSS-px of a capture, derived from the decoded image itself.
 * Snaps to an integer when within 2.5% to absorb scrollbar/clip-rounding noise
 * (real scales are dprs — 1, 2, 3, or clearly fractional like 1.25, never 1.01).
 */
function deriveScale(imagePx: number, cssPx: number): number {
  if (!(imagePx > 0) || !(cssPx > 0)) return 1
  const raw = imagePx / cssPx
  const snapped = Math.round(raw)
  return snapped >= 1 && Math.abs(raw - snapped) / snapped <= 0.025 ? snapped : raw
}

/** Border-box bounding rect in DOCUMENT CSS px, or undefined for non-rendered nodes. */
async function borderBoxDoc(ctx: ToolContext, node: ResolvedNode, info: PageInfo): Promise<Bounds | undefined> {
  try {
    const { model } = await ctx.cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId })
    const b = model.border
    const xs = [b[0]!, b[2]!, b[4]!, b[6]!]
    const ys = [b[1]!, b[3]!, b[5]!, b[7]!]
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    return { x: x + info.scrollX, y: y + info.scrollY, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
  } catch {
    return undefined
  }
}

function loadReference(ref: { image_path?: string; baseline_slot?: string }): Buffer {
  if ((ref.image_path === undefined) === (ref.baseline_slot === undefined)) {
    throw new Error('provide exactly one of reference.image_path or reference.baseline_slot')
  }
  if (ref.image_path !== undefined) {
    try {
      return fs.readFileSync(ref.image_path)
    } catch {
      throw new Error(
        `REFERENCE_NOT_FOUND: no readable file at "${ref.image_path}" — check the path, or record a baseline with ` +
          "style_diff { mode: 'record', capture_pixels: true } and compare via reference.baseline_slot",
      )
    }
  }
  const slot = ref.baseline_slot!
  const buf = loadBaselinePixels(slot)
  if (!buf) {
    throw new Error(
      `BASELINE_SLOT_EMPTY: no pixel baseline recorded under slot '${slot}' — record one with ` +
        `style_diff { mode: 'record', capture_pixels: true, slot: '${slot}' } before comparing`,
    )
  }
  return buf
}

function decodeOrExplain(buf: Buffer, what: string): DecodedPng {
  try {
    return decodePng(buf)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`${what} is not a decodable PNG (${msg}) — pass an 8-bit RGB/RGBA non-interlaced PNG`)
  }
}

function guardSize(img: DecodedPng, what: string): void {
  const px = img.width * img.height
  if (px > MAX_PIXELS) {
    throw new Error(
      `CAPTURE_TOO_LARGE: ${what} is ${img.width}x${img.height} = ${px} px (limit ${MAX_PIXELS}) — ` +
        'shrink the viewport with set_viewport or target a smaller element',
    )
  }
}

/** Dimmed-grayscale capture with counted diff pixels painted solid red. */
function heatmapRgba(img: DecodedPng, isDiff: (x: number, y: number) => boolean): Buffer {
  const out = Buffer.alloc(img.width * img.height * 4)
  let i = 0
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (isDiff(x, y)) {
        out[i++] = 255
        out[i++] = 0
        out[i++] = 0
        out[i++] = 255
      } else {
        const [r, g, b] = img.pixelAt(x, y)
        // Washed-out luma (integer approximation) so red differences pop.
        const gray = (((r * 77 + g * 150 + b * 29) >> 8) >> 1) + 127
        out[i++] = gray
        out[i++] = gray
        out[i++] = gray
        out[i++] = 255
      }
    }
  }
  return out
}

function round(n: number, places: number): number {
  const f = 10 ** places
  return Math.round(n * f) / f
}

export const visualDiffTool: ToolDef = {
  name: 'visual_diff',
  description:
    'Pixel-diff the live page (or one element) against a reference PNG or a recorded baseline slot — ' +
    'MATCH/DIVERGENT verdict with divergence percentage, per-grid-cell regions mapped to likely element uids, ' +
    'and an optional red-on-gray heatmap artifact. Record baselines with ' +
    "style_diff { mode: 'record', capture_pixels: true }; mask timestamps/ads with mask_dynamic.",
  inputSchema,
  async handler(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const a = argsSchema.parse(args)

    const refBuf = loadReference(a.reference)
    const refLabel =
      a.reference.baseline_slot !== undefined ? `baseline '${a.reference.baseline_slot}'` : a.reference.image_path!

    const info = await pageInfo(ctx)

    // ── Capture (annotated_screenshot in clean mode does the CDP work) ──
    let origin: { x: number; y: number } // document CSS px of the capture's (0,0)
    let captureCssWidth: number // CSS px width of the captured area — the derived-scale denominator
    let capture: ToolResult
    let targetLabel: string
    let emulationNote: string | undefined
    if (a.target === 'page') {
      capture = await annotatedScreenshotTool.handler(ctx, { annotate: false })
      origin = { x: info.scrollX, y: info.scrollY }
      captureCssWidth = info.cssWidth
      targetLabel = 'viewport'
    } else {
      const node = await resolveTarget(ctx, { uid: a.target.uid, selector: a.target.selector })
      const box = await borderBoxDoc(ctx, node, info)
      if (!box) {
        throw new Error(
          `target ${node.uid} has no layout box (display:none, detached, or zero-size) — ` +
            "pick a rendered element or use target: 'page'",
        )
      }
      // Same clamp planElementClip applies (clip x/y never go negative).
      origin = { x: Math.max(0, box.x), y: Math.max(0, box.y) }
      captureCssWidth = box.width
      try {
        capture = await annotatedScreenshotTool.handler(ctx, { clipTo: { uid: node.uid }, annotate: false })
      } finally {
        // Empirical (real Chrome): a clipped captureBeyondViewport screenshot permanently
        // resets an EMULATED devicePixelRatio to 1. page.setViewport would no-op here (its
        // args deep-equal puppeteer's cached viewport), so re-assert the override over raw CDP.
        const vp = ctx.page.viewport()
        if (vp?.deviceScaleFactor && vp.deviceScaleFactor !== 1) {
          try {
            await ctx.cdp.send('Emulation.setDeviceMetricsOverride', {
              width: vp.width,
              height: vp.height,
              deviceScaleFactor: vp.deviceScaleFactor,
              mobile: vp.isMobile ?? false,
            })
          } catch {
            emulationNote =
              'note: failed to restore devicePixelRatio emulation after the clipped capture — re-run set_viewport'
          }
        }
      }
      targetLabel = node.uid
    }
    const image = capture.images?.[0]
    if (!image) throw new Error('capture produced no image — check the session with connect and retry')
    const current = decodeOrExplain(Buffer.from(image.data, 'base64'), 'capture')
    guardSize(current, 'capture')
    const reference = decodeOrExplain(refBuf, `reference (${refLabel})`)
    guardSize(reference, 'reference')

    // Image px per CSS px, measured from the decoded capture — window.devicePixelRatio
    // is untrustworthy here (see the module comment on dpr emulation).
    const scale = deriveScale(current.width, captureCssWidth)

    // ── Ignore regions: CSS px (capture-relative) → image px ──
    const ignoreRegions: Bounds[] = a.ignore_regions.map((r) => ({
      x: r.x * scale,
      y: r.y * scale,
      width: r.width * scale,
      height: r.height * scale,
    }))
    let maskedCount = 0
    const skippedMasks: string[] = []
    for (const entry of a.mask_dynamic) {
      let nodes: ResolvedNode[]
      try {
        nodes = await resolveAssertTarget(ctx, entry)
      } catch (err) {
        // mask_dynamic exists for intermittent content (ads, timestamps) — a mask whose
        // element vanished must not abort the diff. Ambiguity, invalid selectors, and
        // session errors still throw.
        if (err instanceof TargetResolutionError && err.code === 'TARGET_NOT_FOUND') {
          skippedMasks.push(typeof entry === 'string' ? entry : entry.selector)
          continue
        }
        throw err
      }
      for (const node of nodes) {
        const rect = await borderBoxDoc(ctx, node, info)
        if (!rect) continue // no layout box → no pixels to mask
        ignoreRegions.push({
          x: (rect.x - origin.x) * scale,
          y: (rect.y - origin.y) * scale,
          width: rect.width * scale,
          height: rect.height * scale,
        })
        maskedCount++
      }
    }
    const notes: string[] = []
    if (skippedMasks.length > 0) notes.push(`mask selector(s) matched 0 elements: ${skippedMasks.join(', ')}`)
    if (emulationNote !== undefined) notes.push(emulationNote)

    // ── Diff (pure engine) ──
    const result = diffImages(reference, current, {
      threshold: a.threshold,
      ignoreAntialiasing: a.ignore_antialiasing,
      ignoreRegions,
      regionGrid: a.region_grid,
    })

    // Running the check is what counts — a DIVERGENT verdict is still a verification pass.
    markVerified('visual_diff')

    if (result.reason === 'layout-diff') {
      const envelope: Envelope = {
        verdict: 'DIVERGENT',
        summary: [
          `DIVERGENT — LAYOUT_MISMATCH: capture (${targetLabel}) is ${current.width}x${current.height} px but ` +
            `reference (${refLabel}) is ${reference.width}x${reference.height} px — re-record the baseline at the ` +
            'current viewport/element size (set_viewport, then style_diff capture_pixels) or pass a same-size image',
          ...notes,
        ].join('; '),
        reason: 'layout-diff',
        divergence_pct: 100,
        diff_pixels: 0,
        total_pixels: 0,
        accept_pct: a.accept_pct,
        regions: [],
        truncated: false,
      }
      return { text: JSON.stringify(envelope, null, 1) }
    }

    const verdict: Envelope['verdict'] = result.divergencePct <= a.accept_pct ? 'MATCH' : 'DIVERGENT'

    // ── Regions above the noise floor → document CSS px + uid attribution ──
    const aboveFloor = result.regions.filter((r) => r.divergencePct > NOISE_FLOOR_PCT)
    const kept = aboveFloor.slice(0, MAX_REGIONS)
    let regionsOut: EnvelopeRegion[] = []
    if (kept.length > 0) {
      const paint = await buildPaintIndex(ctx)
      regionsOut = kept.map((r: DiffRegion): EnvelopeRegion => {
        const docRect: Bounds = {
          x: r.bbox.x / scale + origin.x,
          y: r.bbox.y / scale + origin.y,
          width: r.bbox.width / scale,
          height: r.bbox.height / scale,
        }
        const likelyUids = paint
          .intersecting(docRect, MAX_UIDS_PER_REGION)
          .map((c) => ctx.uids.byBackendId(c.backendNodeId) ?? ctx.uids.assign(c.backendNodeId))
        return {
          grid: r.grid,
          bbox: {
            x: Math.round(docRect.x),
            y: Math.round(docRect.y),
            width: Math.round(docRect.width),
            height: Math.round(docRect.height),
          },
          divergence_pct: round(r.divergencePct, 2),
          likely_uids: likelyUids,
        }
      })
    }

    // ── Heatmap artifact (image paths, never base64 — v-next SPEC §7) ──
    const artifacts: Array<{ kind: string; path: string }> = []
    if (a.emit_heatmap && result.diffMask) {
      const heatPath = artifactPath('diff', 'png')
      fs.writeFileSync(heatPath, encodePng(current.width, current.height, heatmapRgba(current, result.diffMask)))
      artifacts.push({ kind: 'diff-heatmap', path: heatPath })
    }

    const divergencePct = round(result.divergencePct, 4)
    const parts = [
      `${verdict} — divergence ${divergencePct}% (${result.diffPixels} of ${result.totalPixels} compared px, ` +
        `accept_pct ${a.accept_pct}) for ${targetLabel} vs ${refLabel}`,
    ]
    if (regionsOut.length > 0) {
      parts.push(
        `${aboveFloor.length} region(s) above the ${NOISE_FLOOR_PCT}% noise floor; worst ${regionsOut[0]!.grid} @ ${regionsOut[0]!.divergence_pct}%`,
      )
    }
    if (maskedCount > 0) parts.push(`${maskedCount} dynamic element region(s) masked`)
    parts.push(...notes)
    const summary = parts.join('; ')

    // Byte-budget backstop: shrink the regions list until the envelope fits.
    let shown = regionsOut
    let envelope = build(verdict, summary, result, divergencePct, a.accept_pct, shown, artifacts, aboveFloor.length)
    while (JSON.stringify(envelope, null, 1).length > MAX_RESPONSE_BYTES && shown.length > 1) {
      shown = shown.slice(0, Math.max(1, Math.floor(shown.length / 2)))
      envelope = build(verdict, summary, result, divergencePct, a.accept_pct, shown, artifacts, aboveFloor.length)
    }

    return { text: JSON.stringify(envelope, null, 1) }
  },
}

function build(
  verdict: Envelope['verdict'],
  summary: string,
  result: { reason: 'match' | 'pixel-diff' | 'layout-diff'; diffPixels: number; totalPixels: number },
  divergencePct: number,
  acceptPct: number,
  regions: EnvelopeRegion[],
  artifacts: Array<{ kind: string; path: string }>,
  regionsAboveFloor: number,
): Envelope {
  const env: Envelope = {
    verdict,
    summary,
    reason: result.reason,
    divergence_pct: divergencePct,
    diff_pixels: result.diffPixels,
    total_pixels: result.totalPixels,
    accept_pct: acceptPct,
    regions,
    truncated: regions.length < regionsAboveFloor,
  }
  if (artifacts.length > 0) env.artifacts = artifacts
  return env
}
