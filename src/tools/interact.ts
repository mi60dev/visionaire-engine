/**
 * interact — DRIVE the UI to a state and LEAVE it there.
 *
 * Unlike record_interaction (which opens the Animation/Debugger/stack-trace
 * channels, records a causal timeline, and tears every channel back down —
 * often returning the page to its pre-interaction state), interact does the
 * minimum: dispatch one input at the target and report the target's POST-action
 * geometry + visibility. Nothing is enabled, disabled, injected, or reverted, so
 * a popup opened here STAYS open — the agent can then inspect_element /
 * annotated_screenshot / explain_styles the resulting state.
 *
 * Empirical facts baked in (probed against headless Chrome before coding):
 *   - Input.dispatchMouseEvent needs a `mouseMoved` before press/release, or
 *     hover-resolved input targets miss (same requirement pick_element/record hit).
 *   - DOM.getBoxModel THROWS "Could not compute box model" for non-rendered nodes
 *     (display:none, detached) — for those we fall back to getBoundingClientRect
 *     via a scoped Runtime.callFunctionOn (which also scrollIntoViews first).
 */
import { z } from 'zod'
import type { ResolvedNode, TargetSpec, ToolContext, ToolDef } from '../types.js'
import { resolveTarget } from '../uid.js'
import { getBoxSummary } from '../engine/box-model.js'
import { assessVisibility } from '../engine/visibility.js'
import { formatBounds } from '../format/dossier.js'

const OBJECT_GROUP = 'visionaire-interact'

const DEFAULT_SETTLE_MS = 250
const MIN_SETTLE_MS = 0
const MAX_SETTLE_MS = 5000

const inputSchema = {
  uid: z.string().optional().describe('Element uid from a prior page_snapshot (e.g. "e5")'),
  selector: z.string().optional().describe('CSS selector — first match is used'),
  x: z.number().optional().describe('Viewport x coordinate (use with y)'),
  y: z.number().optional().describe('Viewport y coordinate (use with x)'),
  action: z
    .enum(['click', 'hover', 'focus'])
    .optional()
    .describe('What to do at the target — default "click". hover moves the mouse over it; focus focuses it.'),
  settleMs: z
    .number()
    .optional()
    .describe(
      `How long to wait for the UI to react before reporting the target's new state; default ${DEFAULT_SETTLE_MS}, clamped ${MIN_SETTLE_MS}–${MAX_SETTLE_MS}`,
    ),
}

const argsSchema = z.object(inputSchema)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

function targetFromArgs(a: z.infer<typeof argsSchema>): TargetSpec {
  return { uid: a.uid, selector: a.selector, x: a.x, y: a.y }
}

/**
 * Center of the target in viewport coords. Prefers DOM.getBoxModel; falls back to
 * getBoundingClientRect via a scoped callFunctionOn (also scrollIntoViews the node,
 * matching record_interaction). Returns undefined only when the node has no
 * geometry at all (display:none / detached — nothing to click).
 */
async function targetCenter(
  ctx: ToolContext,
  node: ResolvedNode,
): Promise<{ x: number; y: number } | undefined> {
  try {
    const { model } = await ctx.cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId })
    const q = model.content
    const cx = (q[0] + q[2] + q[4] + q[6]) / 4
    const cy = (q[1] + q[3] + q[5] + q[7]) / 4
    if (model.width > 0 && model.height > 0) return { x: Math.round(cx), y: Math.round(cy) }
    // Zero-size box: fall through to the rect probe (may still have a usable point).
  } catch {
    // "Could not compute box model" for non-rendered nodes — try the rect probe.
  }

  try {
    const { object } = await ctx.cdp.send('DOM.resolveNode', {
      backendNodeId: node.backendNodeId,
      objectGroup: OBJECT_GROUP,
    })
    if (!object.objectId) return undefined
    const geom = await ctx.cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function () {
        this.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const r = this.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height });
      }`,
      returnByValue: true,
    })
    if (typeof geom.result.value !== 'string') return undefined
    const parsed = JSON.parse(geom.result.value) as { x: number; y: number; w: number; h: number }
    if (parsed.w <= 0 || parsed.h <= 0) return undefined
    return { x: Math.round(parsed.x), y: Math.round(parsed.y) }
  } catch {
    return undefined
  } finally {
    await ctx.cdp.send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => {})
  }
}

/** Focus the node; fall back to an in-page el.focus() if DOM.focus can't. Best-effort. */
async function focusNode(ctx: ToolContext, node: ResolvedNode): Promise<void> {
  try {
    await ctx.cdp.send('DOM.focus', { backendNodeId: node.backendNodeId })
    return
  } catch {
    /* DOM.focus fails on non-focusable / detached nodes — try the DOM API */
  }
  try {
    const { object } = await ctx.cdp.send('DOM.resolveNode', {
      backendNodeId: node.backendNodeId,
      objectGroup: OBJECT_GROUP,
    })
    if (object.objectId) {
      await ctx.cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: 'function () { if (typeof this.focus === "function") this.focus(); }',
      })
    }
  } catch {
    /* best-effort */
  } finally {
    await ctx.cdp.send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => {})
  }
}

function tagLabel(uid: string, entry: ReturnType<ToolContext['uids']['get']>): string {
  const tag = entry?.tag ?? '?'
  const id = entry?.attrId ? `#${entry.attrId}` : ''
  const cls = (entry?.classes ?? [])
    .slice(0, 2)
    .map((c) => `.${c}`)
    .join('')
  return `${uid} <${tag}${id}${cls}>`
}

export const interactTool: ToolDef = {
  name: 'interact',
  description:
    'Perform ONE action (click/hover/focus) at a target and LEAVE the resulting state in place — ' +
    'no recording, no teardown. Use this to DRIVE the UI to a state (open a popup/menu/modal, reveal ' +
    'a tab) so you can then inspect_element / annotated_screenshot / explain_styles the new state. ' +
    'Reports the target\'s post-action visibility + box so you learn immediately whether it opened. ' +
    'Target by uid, selector, or x+y. (For the causal TIMELINE of an interaction — which handler ran, ' +
    'what mutated, transitions cancelled — use record_interaction instead.)',
  inputSchema,
  async handler(ctx, args) {
    const a = argsSchema.parse(args)
    const action = a.action ?? 'click'
    const settleMs = clamp(Math.round(a.settleMs ?? DEFAULT_SETTLE_MS), MIN_SETTLE_MS, MAX_SETTLE_MS)

    const node = await resolveTarget(ctx, targetFromArgs(a)) // throws helpfully when the target is missing/stale
    const targetLabel = tagLabel(node.uid, ctx.uids.get(node.uid))

    // ── perform the action ──
    if (action === 'focus') {
      await focusNode(ctx, node)
    } else {
      const center = await targetCenter(ctx, node)
      if (!center) {
        throw new Error(
          `${targetLabel} has no clickable geometry (not rendered — display:none, zero-size, or detached). ` +
            'Make it visible first, or target a visible element.',
        )
      }
      // mouseMoved FIRST is required — Chrome resolves the input target from hover
      // state (verified empirically here and in pick_element/record_interaction).
      await ctx.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: center.x, y: center.y })
      if (action === 'click') {
        await ctx.cdp.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: center.x,
          y: center.y,
          button: 'left',
          clickCount: 1,
        })
        await ctx.cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: center.x,
          y: center.y,
          button: 'left',
          clickCount: 1,
        })
      }
    }

    // ── let the UI react, then report the target's NEW state ──
    if (settleMs > 0) await sleep(settleMs)

    // Re-resolve: the action may have re-rendered/replaced the target node. Same
    // TargetSpec, but a fresh backendNodeId if the DOM swapped it out. Fall back to
    // the original resolution if the target vanished (e.g. clicking a close button
    // that removes itself).
    let after: ResolvedNode = node
    try {
      after = await resolveTarget(ctx, targetFromArgs(a))
    } catch {
      after = node
    }

    const visibility = await assessVisibility(ctx, after)
    const box = await getBoxSummary(ctx, after)

    const verb = action === 'click' ? 'clicked' : action === 'hover' ? 'hovered' : 'focused'
    const afterLabel = tagLabel(after.uid, ctx.uids.get(after.uid))
    const settleText = settleMs > 0 ? ` — after ${settleMs}ms` : ''

    const lines: string[] = []
    if (visibility.visible && box) {
      lines.push(
        `${verb} ${targetLabel}${settleText}: it is now visible ${formatBounds(box.content)}.`,
      )
    } else if (visibility.visible) {
      lines.push(`${verb} ${targetLabel}${settleText}: it is now visible.`)
    } else {
      lines.push(
        `${verb} ${targetLabel}${settleText}: it is ${visibility.status}${visibility.cause ? ` (${visibility.cause})` : ''}.`,
      )
    }
    if (afterLabel !== targetLabel) {
      lines.push(`(the target re-resolved to ${afterLabel} after the action)`)
    }
    lines.push(
      'The page is now left in this new state. uids may have changed and new elements may have appeared — ' +
        'take a fresh page_snapshot to inspect the new state, then inspect_element / annotated_screenshot it.',
    )

    return { text: lines.join('\n') }
  },
}
