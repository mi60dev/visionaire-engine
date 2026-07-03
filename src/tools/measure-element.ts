/**
 * measure_element — deterministic rendered-pixel / glyph geometry.
 *
 * The field report's standout gap: to center a glyph to sub-pixel accuracy the
 * user had to hand-roll a CDP+canvas+PIL harness, because no tool reported the
 * true text-ink bounding box vs the element's content box. This does exactly
 * that, deterministically, in one in-page evaluate:
 *
 *   - content box: getBoundingClientRect minus padding + border (getComputedStyle)
 *   - text ink box: canvas 2d measureText actualBoundingBox* extents (the true
 *     glyph ink, not the advance box), anchored to the painted text via a Range
 *   - centering: ink center vs content-box center on both axes, with fix hints
 *
 * Optionally measures alignment against a reference element's center instead of
 * (or in addition to) the element's own ink-vs-box centering.
 */
import { z } from 'zod'
import type { ResolvedNode, TargetSpec, ToolContext, ToolDef, ToolResult } from '../types.js'
import { sanitizePageText } from '../types.js'
import { resolveTarget } from '../uid.js'
import {
  centeringDeltas,
  inkBox,
  measureExpression,
  type ContentBox,
  type InkBox,
  type MeasurePayload,
} from '../engine/geometry.js'

const OBJECT_GROUP = 'visionaire-measure'

interface MeasureArgs extends TargetSpec {
  referenceUid?: string
  referenceSelector?: string
}

function targetFromArgs(args: Record<string, unknown>): TargetSpec {
  return {
    uid: typeof args.uid === 'string' ? args.uid : undefined,
    selector: typeof args.selector === 'string' ? args.selector : undefined,
    x: typeof args.x === 'number' ? args.x : undefined,
    y: typeof args.y === 'number' ? args.y : undefined,
  }
}

/** Run measureExpression against a resolved node; throws with an actionable message on failure. */
async function measure(ctx: ToolContext, node: ResolvedNode): Promise<MeasurePayload> {
  const { object } = await ctx.cdp.send('DOM.resolveNode', {
    nodeId: node.nodeId,
    objectGroup: OBJECT_GROUP,
  })
  if (!object.objectId) {
    throw new Error(`element ${node.uid} could not be resolved to an in-page object (not rendered?)`)
  }
  const res = await ctx.cdp.send('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: measureExpression(),
    returnByValue: true,
  })
  if (res.exceptionDetails) {
    const msg = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text
    throw new Error(`measurement failed for ${node.uid}: ${String(msg).split('\n')[0]}`)
  }
  const value = res.result.value as MeasurePayload | undefined
  if (!value || !value.content) {
    throw new Error(`element ${node.uid} returned no geometry (it may have no layout box)`)
  }
  return value
}

function fmt(n: number): string {
  const r = Math.round(n * 10) / 10
  return Number.isInteger(r) ? String(r) : r.toFixed(1)
}

function boxLine(label: string, box: ContentBox): string {
  return `${label}: ${fmt(box.width)}x${fmt(box.height)} @(${fmt(box.x)},${fmt(box.y)})`
}

/** Signed delta with an explicit sign, e.g. "+6.1px" / "-1.3px" / "0px". */
function signed(n: number): string {
  const r = Math.round(n * 10) / 10
  const s = r > 0 ? '+' : r < 0 ? '' : '' // negatives already carry '-'
  return `${s}${fmt(r)}px`
}

function elementHeader(ctx: ToolContext, node: ResolvedNode, textPreview?: string): string {
  const entry = ctx.uids.get(node.uid)
  const tag = entry?.tag ?? 'element'
  const id = entry?.attrId ? `#${entry.attrId}` : ''
  const cls = (entry?.classes ?? []).map((c) => `.${c}`).join('')
  const text = textPreview ? ` "${textPreview}"` : ''
  return `element ${node.uid} <${tag}${id}${cls}>${text}`
}

export const measureElementTool: ToolDef = {
  name: 'measure_element',
  description:
    "Deterministic rendered-pixel geometry: the element's content box (WxH @x,y), the true " +
    'TEXT INK bounding box of its text (canvas measureText glyph extents, not the advance box) ' +
    'with font, and a centering verdict — how far the text ink sits from the content-box center ' +
    'on each axis, with a fix hint (shift/padding/line-height). Answers "is this glyph actually ' +
    'centered?" to sub-pixel accuracy without a hand-rolled canvas harness. Pass a reference ' +
    'element (referenceUid/referenceSelector) to also get the delta between the two elements’ ' +
    'centers. Target by uid (from page_snapshot), CSS selector, or viewport x+y.',
  inputSchema: {
    uid: z.string().optional().describe('Element uid from a prior page_snapshot (e.g. "e17")'),
    selector: z.string().optional().describe('CSS selector — first match is used'),
    x: z.number().optional().describe('Viewport x coordinate (use with y)'),
    y: z.number().optional().describe('Viewport y coordinate (use with x)'),
    referenceUid: z
      .string()
      .optional()
      .describe('Optional reference element uid to measure alignment against (its center)'),
    referenceSelector: z
      .string()
      .optional()
      .describe('Optional reference element selector to measure alignment against (its center)'),
  },
  async handler(ctx, args): Promise<ToolResult> {
    const a = args as MeasureArgs
    try {
      const node = await resolveTarget(ctx, targetFromArgs(args))
      const payload = await measure(ctx, node)

      const lines: string[] = []
      const preview = payload.ink.empty ? undefined : sanitizePageText(payload.text, 24)
      lines.push(elementHeader(ctx, node, preview))
      lines.push(boxLine('content box', payload.content))

      if (payload.ink.empty) {
        lines.push('text ink: (no text to measure)')
      } else {
        const ib: InkBox = inkBox(payload.ink)
        const glyph = sanitizePageText(payload.text, 24)
        lines.push(
          `text ink: ${fmt(ib.width)}x${fmt(ib.height)}  font ${payload.fontShort}  text "${glyph}"`,
        )
        const c = centeringDeltas(payload.content, ib)
        lines.push('centering (text ink vs content box):')
        lines.push(
          `  horizontal: ${signed(c.horizontal)} ` +
            `(ink ${c.horizontal > 0 ? 'right' : c.horizontal < 0 ? 'left' : 'at'} of center)`,
        )
        lines.push(
          `  vertical:   ${signed(c.vertical)} ` +
            `(ink ${c.vertical > 0 ? 'below' : c.vertical < 0 ? 'above' : 'at'} center)`,
        )
        lines.push(`  ${c.hint}`)
      }

      // ── optional reference alignment: element center vs reference center ──
      const refTarget: TargetSpec = {
        uid: typeof a.referenceUid === 'string' ? a.referenceUid : undefined,
        selector: typeof a.referenceSelector === 'string' ? a.referenceSelector : undefined,
      }
      if (refTarget.uid !== undefined || refTarget.selector !== undefined) {
        const refNode = await resolveTarget(ctx, refTarget)
        const refPayload = await measure(ctx, refNode)
        const selfC = {
          x: payload.content.x + payload.content.width / 2,
          y: payload.content.y + payload.content.height / 2,
        }
        const refC = {
          x: refPayload.content.x + refPayload.content.width / 2,
          y: refPayload.content.y + refPayload.content.height / 2,
        }
        const dx = Math.round((selfC.x - refC.x) * 10) / 10
        const dy = Math.round((selfC.y - refC.y) * 10) / 10
        const refEntry = ctx.uids.get(refNode.uid)
        const refTag = refEntry?.tag ?? 'element'
        lines.push(`alignment vs reference ${refNode.uid} <${refTag}> (content-box centers):`)
        lines.push(
          `  horizontal: ${signed(dx)} ` +
            `(target ${dx > 0 ? 'right' : dx < 0 ? 'left' : 'aligned with'} reference)`,
        )
        lines.push(
          `  vertical:   ${signed(dy)} ` +
            `(target ${dy > 0 ? 'below' : dy < 0 ? 'above' : 'aligned with'} reference)`,
        )
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
          lines.push('  centers coincide (within 0.5px on both axes)')
        }
      }

      return { text: lines.join('\n') }
    } finally {
      await ctx.cdp.send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => {})
    }
  },
}
