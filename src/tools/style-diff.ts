/**
 * style_diff — record whitelisted computed styles + box model for a target,
 * later compare and emit only the deltas (verify-my-fix loops). SPEC §4.
 */
import { z } from 'zod'
import type {
  Bounds,
  BoxSummary,
  ResolvedNode,
  TargetSpec,
  ToolContext,
  ToolDef,
  ToolResult,
} from '../types.js'
import { COMPUTED_WHITELIST, estimateTokens } from '../types.js'
import { resolveTarget } from '../uid.js'
import { getBoxSummary } from '../engine/box-model.js'
import { formatBounds } from '../format/dossier.js'

const DIFF_BUDGET_TOKENS = 800
/** Ignore sub-pixel layout noise when diffing box geometry. */
const BOX_EPSILON = 0.5

interface DiffSlot {
  selector?: string
  uid?: string
  values: Map<string, string>
  box?: BoxSummary
}

// Module-level so slots survive navigation (SPEC §4: keyed by slot name).
const slots = new Map<string, DiffSlot>()

interface StyleDiffArgs extends TargetSpec {
  mode: 'record' | 'compare'
  slot?: string
}

export const styleDiffTool: ToolDef = {
  name: 'style_diff',
  description:
    'Record the computed styles + box model of an element, then later compare and get only ' +
    "what changed ('prop: old → new' plus box deltas) — ideal for verify-my-fix loops. " +
    'record: stores a baseline under a named slot. compare: re-reads the element (re-resolving ' +
    'by stored selector if the uid went stale after navigation) and diffs against the baseline.',
  inputSchema: {
    uid: z.string().optional().describe('Element uid from a prior page_snapshot / find_elements'),
    selector: z.string().optional().describe('CSS selector (first match) — alternative to uid'),
    x: z.number().optional().describe('Viewport x coordinate — use together with y'),
    y: z.number().optional().describe('Viewport y coordinate — use together with x'),
    mode: z.enum(['record', 'compare']).describe('record: store baseline. compare: diff against it'),
    slot: z
      .string()
      .default('default')
      .describe('Recording slot name — omit the target on compare to reuse the recorded one'),
  },
  handler: styleDiff,
}

async function styleDiff(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const a = args as unknown as StyleDiffArgs
  const slot = a.slot ?? 'default'
  return a.mode === 'record' ? record(ctx, a, slot) : compare(ctx, a, slot)
}

async function record(ctx: ToolContext, a: TargetSpec, slot: string): Promise<ToolResult> {
  const node = await resolveTarget(ctx, a)
  const values = await readWhitelisted(ctx, node)
  const box = await readBox(ctx, node)
  const entry = ctx.uids.get(node.uid)
  // Keep a selector so the slot survives navigation when the uid goes stale.
  const selector = a.selector ?? (entry?.attrId ? `#${entry.attrId}` : undefined)
  slots.set(slot, { selector, uid: node.uid, values, box })
  const boxNote = box ? ' + box model' : ' (no box model — element has no layout box)'
  return {
    text:
      `recorded ${values.size} computed properties${boxNote} for ${node.uid} under slot '${slot}'. ` +
      `Make your change, then call style_diff { mode: 'compare', slot: '${slot}' }.`,
  }
}

async function compare(ctx: ToolContext, a: TargetSpec, slot: string): Promise<ToolResult> {
  const rec = slots.get(slot)
  if (!rec) {
    throw new Error(`No recording under slot '${slot}' — call style_diff { mode: 'record' } on the target first.`)
  }
  const node = await resolveForCompare(ctx, a, rec)
  const values = await readWhitelisted(ctx, node)
  const box = await readBox(ctx, node)

  const changes: string[] = []
  for (const prop of COMPUTED_WHITELIST) {
    const oldV = rec.values.get(prop)
    const newV = values.get(prop)
    if (oldV !== newV) changes.push(`${prop}: ${oldV ?? '(unset)'} → ${newV ?? '(unset)'}`)
  }
  changes.push(...boxDeltaLines(rec.box, box))

  // Refresh the stored uid so subsequent compares resolve fast; baseline values stay put.
  rec.uid = node.uid

  const identity = identityOf(ctx, node.uid)
  if (!changes.length) {
    return {
      text: `no changes — ${values.size} tracked properties and box model match the '${slot}' recording for ${node.uid}${identity}.`,
    }
  }

  const header = `style diff (slot '${slot}') for ${node.uid}${identity}:`
  const lines: string[] = [header]
  let used = estimateTokens(header)
  for (let i = 0; i < changes.length; i++) {
    const line = `  ${changes[i]}`
    used += estimateTokens(line)
    if (used > DIFF_BUDGET_TOKENS && i < changes.length - 1) {
      lines.push(`  [${changes.length - i} more changes truncated — budget]`)
      break
    }
    lines.push(line)
  }
  return { text: lines.join('\n') }
}

/** Explicit target wins; else stored uid, falling back to the stored selector when stale. */
async function resolveForCompare(ctx: ToolContext, a: TargetSpec, rec: DiffSlot): Promise<ResolvedNode> {
  if (a.uid !== undefined || a.selector !== undefined || a.x !== undefined || a.y !== undefined) {
    return resolveTarget(ctx, a)
  }
  if (rec.uid) {
    try {
      return await resolveTarget(ctx, { uid: rec.uid })
    } catch (err) {
      if (rec.selector) {
        try {
          return await resolveTarget(ctx, { selector: rec.selector })
        } catch {
          throw new Error(
            `Recorded target is stale: uid ${rec.uid} is gone and selector '${rec.selector}' no longer matches. ` +
              'Pass an explicit uid/selector to compare.',
          )
        }
      }
      throw err
    }
  }
  if (rec.selector) return resolveTarget(ctx, { selector: rec.selector })
  throw new Error('Recording has no re-resolvable target — pass a uid or selector to compare.')
}

async function readWhitelisted(ctx: ToolContext, node: ResolvedNode): Promise<Map<string, string>> {
  const res = await ctx.cdp.send('CSS.getComputedStyleForNode', { nodeId: node.nodeId })
  const all = new Map(res.computedStyle.map((p) => [p.name, p.value]))
  const out = new Map<string, string>()
  for (const prop of COMPUTED_WHITELIST) {
    const v = all.get(prop)
    if (v !== undefined) out.set(prop, v)
  }
  return out
}

async function readBox(ctx: ToolContext, node: ResolvedNode): Promise<BoxSummary | undefined> {
  try {
    return await getBoxSummary(ctx, node)
  } catch {
    // display:none / detached nodes have no box — diff reports its disappearance instead
    return undefined
  }
}

function boxDeltaLines(oldBox: BoxSummary | undefined, newBox: BoxSummary | undefined): string[] {
  if (!oldBox && !newBox) return []
  if (!oldBox || !newBox) {
    const oldS = oldBox ? formatBounds(oldBox.content) : '(no box)'
    const newS = newBox ? formatBounds(newBox.content) : '(no box — element not rendered)'
    return [`box: ${oldS} → ${newS}`]
  }
  const lines: string[] = []
  if (boundsDiffer(oldBox.content, newBox.content)) {
    lines.push(`box content: ${formatBounds(oldBox.content)} → ${formatBounds(newBox.content)}`)
  }
  for (const part of ['padding', 'border', 'margin'] as const) {
    if (edgesDiffer(oldBox[part], newBox[part])) {
      lines.push(`box ${part}: ${edgesStr(oldBox[part])} → ${edgesStr(newBox[part])}`)
    }
  }
  return lines
}

function boundsDiffer(a: Bounds, b: Bounds): boolean {
  return (
    Math.abs(a.x - b.x) > BOX_EPSILON ||
    Math.abs(a.y - b.y) > BOX_EPSILON ||
    Math.abs(a.width - b.width) > BOX_EPSILON ||
    Math.abs(a.height - b.height) > BOX_EPSILON
  )
}

function edgesDiffer(a: [number, number, number, number], b: [number, number, number, number]): boolean {
  return a.some((v, i) => Math.abs(v - b[i]!) > BOX_EPSILON)
}

function edgesStr(e: [number, number, number, number]): string {
  const [t, r, b, l] = e.map(fmtNum) as [string, string, string, string]
  return t === r && r === b && b === l ? t : `${t} ${r} ${b} ${l}`
}

function fmtNum(n: number): string {
  const r = Math.round(n * 10) / 10
  return Number.isInteger(r) ? String(r) : r.toFixed(1)
}

function identityOf(ctx: ToolContext, uid: string): string {
  const entry = ctx.uids.get(uid)
  if (!entry?.tag) return ''
  const id = entry.attrId ? `#${entry.attrId}` : ''
  const cls = entry.classes?.length ? `.${entry.classes.slice(0, 3).join('.')}` : ''
  return ` <${entry.tag}${id}${cls}>`
}
