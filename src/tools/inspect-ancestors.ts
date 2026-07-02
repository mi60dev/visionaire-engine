/**
 * inspect_ancestors — constraint-chain walk. SPEC §4, §6.4, §6.5.
 * One compact line per ancestor (self first), binding constraint flagged;
 * for concern 'stacking' a closing note when the element's z-index is scoped
 * inside a non-root stacking context.
 */
import { z } from 'zod'
import type { AncestorLine, TargetSpec, ToolDef } from '../types.js'
import { estimateTokens } from '../types.js'
import { resolveTarget } from '../uid.js'
import { walkAncestors, type AncestorConcern } from '../engine/ancestors.js'

const CONCERNS = ['width', 'height', 'position', 'overflow', 'stacking'] as const
const MAX_TOKENS = 800

function targetFromArgs(args: Record<string, unknown>): TargetSpec {
  return {
    uid: typeof args.uid === 'string' ? args.uid : undefined,
    selector: typeof args.selector === 'string' ? args.selector : undefined,
    x: typeof args.x === 'number' ? args.x : undefined,
    y: typeof args.y === 'number' ? args.y : undefined,
  }
}

function identity(line: AncestorLine): string {
  const id = line.attrId ? `#${line.attrId}` : ''
  const classes = line.classes
    .slice(0, 3)
    .map((c) => `.${c}`)
    .join('')
  return `<${line.tag}${id}${classes}>`
}

function renderLine(line: AncestorLine): string {
  return `${line.uid} ${identity(line)} ${line.summary}${line.binding ? ' [BINDING]' : ''}`
}

function stackingNote(lines: AncestorLine[]): string | undefined {
  const self = lines[0]
  if (!self) return undefined
  const zMatch = /z-index:(-?\d+)/.exec(self.summary)
  if (!zMatch) return undefined
  const bindingIdx = lines.findIndex((l, i) => i > 0 && l.binding === true)
  // Scoped only when the nearest context is NOT the root (last line).
  if (bindingIdx <= 0 || bindingIdx === lines.length - 1) return undefined
  const context = lines[bindingIdx]
  const reasonMatch = /creates stacking context: (.+)$/.exec(context.summary)
  const reason = reasonMatch ? reasonMatch[1] : 'stacking context'
  return `note: z-index:${zMatch[1]} is scoped inside context created by ${context.uid} (${reason}) — it cannot escape that context`
}

export const inspectAncestorsTool: ToolDef = {
  name: 'inspect_ancestors',
  description:
    'Walk the ancestor chain (self → root) reporting only the properties relevant to one ' +
    'concern — width | height | position | overflow | stacking — one compact line per ' +
    'ancestor with its uid, flagging the binding constraint. Use it to answer "which ' +
    'ancestor constrains this element". Target by uid, CSS selector, or viewport x+y.',
  inputSchema: {
    uid: z.string().optional().describe('Element uid from a prior page_snapshot (e.g. "e8")'),
    selector: z.string().optional().describe('CSS selector — first match is used'),
    x: z.number().optional().describe('Viewport x coordinate (use with y)'),
    y: z.number().optional().describe('Viewport y coordinate (use with x)'),
    concern: z
      .enum(CONCERNS)
      .optional()
      .describe('Which constraint chain to report (default: width)'),
  },
  async handler(ctx, args) {
    const node = await resolveTarget(ctx, targetFromArgs(args))
    const concern: AncestorConcern =
      typeof args.concern === 'string' && (CONCERNS as readonly string[]).includes(args.concern)
        ? (args.concern as AncestorConcern)
        : 'width'

    const lines = await walkAncestors(ctx, node, concern)
    if (lines.length === 0) {
      return { text: `no ancestor chain for ${node.uid} — node may be detached` }
    }

    const header = `ancestors of ${lines[0].uid} ${identity(lines[0])} — concern: ${concern} (self → root)`
    const body = lines.map(renderLine)
    const note = concern === 'stacking' ? stackingNote(lines) : undefined

    let text = [header, ...body, ...(note ? [note] : [])].join('\n')
    if (estimateTokens(text) > MAX_TOKENS) {
      // Deep chains: keep self + nearest ancestors, always keep the root line.
      const maxLines = Math.max(3, Math.floor((MAX_TOKENS * 4) / 60) - 2)
      const kept = body.slice(0, maxLines)
      const dropped = body.length - kept.length - 1
      if (dropped > 0) {
        kept.push(`[${dropped} more ancestors pruned]`, body[body.length - 1])
        text = [header, ...kept, ...(note ? [note] : [])].join('\n')
      }
    }
    return { text }
  },
}
