/**
 * page_snapshot — Pass-1 census (SPEC §4): DOMSnapshot.captureSnapshot decoded from
 * its columnar format into a SnapshotNode tree with stable uids, rendered by renderCensus.
 */
import type { Protocol } from 'puppeteer-core'
import { z } from 'zod'
import type {
  Bounds,
  PageMeta,
  SnapshotNode,
  TargetSpec,
  ToolContext,
  ToolDef,
  ToolResult,
} from '../types.js'
import { COMPUTED_WHITELIST } from '../types.js'
import { resolveTarget } from '../uid.js'
import { renderCensus } from '../format/census.js'
import { detectPlatformFromPage } from '../attribution/wordpress.js'

const ELEMENT_NODE = 1
const TEXT_NODE = 3

/** Non-rendering metadata elements — excluded from the census entirely. */
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'base', 'title'])

const LAYOUT_DISPLAYS = new Set(['flex', 'grid', 'inline-flex', 'inline-grid'])
const LAYOUT_POSITIONS = new Set(['sticky', 'fixed', 'absolute'])

function snapshotToTree(
  ctx: ToolContext,
  doc: Protocol.DOMSnapshot.DocumentSnapshot,
  strings: string[],
  viewport: Bounds,
  scopeBackendId?: number,
): SnapshotNode {
  const nodes = doc.nodes
  const parentIndex = nodes.parentIndex ?? []
  const nodeTypes = nodes.nodeType ?? []
  const nodeNames = nodes.nodeName ?? []
  const nodeValues = nodes.nodeValue ?? []
  const backendIds = nodes.backendNodeId ?? []
  const attributes = nodes.attributes ?? []
  const count = nodeTypes.length
  const layout = doc.layout

  const str = (i: number | undefined): string | undefined =>
    i === undefined || i < 0 || i >= strings.length ? undefined : strings[i]

  const tagOf = (i: number): string => (str(nodeNames[i]) ?? '').toLowerCase()

  // Pseudo-element rows (::before etc.) come through as element nodes; skip them.
  const pseudo = new Set(nodes.pseudoType?.index ?? [])

  const childIndices: number[][] = Array.from({ length: count }, () => [])
  for (let i = 0; i < count; i++) {
    const p = parentIndex[i]
    if (p !== undefined && p >= 0 && p < count) childIndices[p]!.push(i)
  }

  // One layout row per node (first wins; text nodes get their own rows we never query).
  const rowByNode = new Map<number, number>()
  layout.nodeIndex.forEach((nodeIdx, row) => {
    if (!rowByNode.has(nodeIdx)) rowByNode.set(nodeIdx, row)
  })

  // styles[row] holds one string index per requested computed style, in request order.
  const styleIdx = new Map<string, number>()
  COMPUTED_WHITELIST.forEach((p, i) => styleIdx.set(p, i))
  const styleOf = (row: number, prop: string): string | undefined => {
    const arr = layout.styles[row]
    const i = styleIdx.get(prop)
    if (!arr || i === undefined) return undefined
    return str(arr[i])
  }

  const boundsOf = (row: number): Bounds | undefined => {
    const r = layout.bounds[row]
    if (!r || r.length < 4) return undefined
    return { x: r[0]!, y: r[1]!, width: r[2]!, height: r[3]! }
  }

  const attrsOf = (i: number): Map<string, string> => {
    const map = new Map<string, string>()
    const flat = attributes[i]
    if (!flat) return map
    for (let j = 0; j + 1 < flat.length; j += 2) {
      const name = str(flat[j])
      if (name !== undefined) map.set(name, str(flat[j + 1]) ?? '')
    }
    return map
  }

  const visibilityOf = (row: number | undefined): { visible: boolean; reason?: string } => {
    // display:none subtrees have no layout object at all.
    if (row === undefined) return { visible: false, reason: 'display:none' }
    if (styleOf(row, 'display') === 'none') return { visible: false, reason: 'display:none' }
    const vis = styleOf(row, 'visibility')
    if (vis === 'hidden' || vis === 'collapse') return { visible: false, reason: 'visibility:hidden' }
    const b = boundsOf(row)
    if (!b) return { visible: false, reason: 'display:none' }
    if (b.width === 0 || b.height === 0) {
      // SPEC §6.2: zero-size only counts when overflow can't paint children.
      const clips = styleOf(row, 'overflow-x') !== 'visible' || styleOf(row, 'overflow-y') !== 'visible'
      if (clips) return { visible: false, reason: 'zero-size' }
    }
    if (b.width > 0 && b.height > 0) {
      const outside =
        b.x + b.width <= viewport.x ||
        b.y + b.height <= viewport.y ||
        b.x >= viewport.x + viewport.width ||
        b.y >= viewport.y + viewport.height
      if (outside) return { visible: false, reason: 'off-viewport' }
    }
    return { visible: true }
  }

  const layoutHintOf = (row: number | undefined): string | undefined => {
    if (row === undefined) return undefined
    const hints: string[] = []
    const display = styleOf(row, 'display')
    if (display !== undefined && LAYOUT_DISPLAYS.has(display)) hints.push(display)
    const position = styleOf(row, 'position')
    if (position !== undefined && LAYOUT_POSITIONS.has(position)) hints.push(position)
    const z = styleOf(row, 'z-index')
    if (z !== undefined && z !== 'auto' && position !== undefined && position !== 'static') hints.push(`z:${z}`)
    return hints.length > 0 ? hints.join(' ') : undefined
  }

  let rootIdx = -1
  if (scopeBackendId !== undefined) {
    for (let i = 0; i < count; i++) {
      if (backendIds[i] === scopeBackendId && nodeTypes[i] === ELEMENT_NODE) {
        rootIdx = i
        break
      }
    }
    if (rootIdx < 0) {
      throw new Error(
        'scope target not found in the main document snapshot — iframe subtrees are not supported in v0.1.',
      )
    }
  } else {
    for (let i = 0; i < count; i++) {
      if (nodeTypes[i] === ELEMENT_NODE && !pseudo.has(i) && tagOf(i) === 'body') {
        rootIdx = i
        break
      }
    }
    if (rootIdx < 0) {
      for (let i = 0; i < count; i++) {
        if (nodeTypes[i] === ELEMENT_NODE && !pseudo.has(i)) {
          rootIdx = i
          break
        }
      }
    }
    if (rootIdx < 0) throw new Error('Snapshot contains no element nodes — is a page loaded?')
  }

  // Pre-order build: uid assigned before children → document-order numbering.
  const build = (i: number): SnapshotNode => {
    const attrs = attrsOf(i)
    const tag = tagOf(i)
    const classes = (attrs.get('class') ?? '').split(/\s+/).filter(Boolean)
    const attrId = attrs.get('id') || undefined

    let rawText = ''
    for (const c of childIndices[i]!) {
      if (nodeTypes[c] === TEXT_NODE) rawText += ` ${str(nodeValues[c]) ?? ''}`
    }
    rawText = rawText.replace(/\s+/g, ' ').trim()
    const text =
      rawText === '' ? undefined : rawText.length > 30 ? `${rawText.slice(0, 29).trimEnd()}…` : rawText

    const row = rowByNode.get(i)
    const { visible, reason } = visibilityOf(row)
    const backendNodeId = backendIds[i] ?? -1
    const uid = ctx.uids.assign(backendNodeId, { tag, classes, attrId, textPreview: text })

    const node: SnapshotNode = {
      uid,
      backendNodeId,
      tag,
      classes,
      attrId,
      text,
      bounds: row !== undefined ? boundsOf(row) : undefined,
      paintOrder: row !== undefined ? layout.paintOrders?.[row] : undefined,
      visible,
      invisibleReason: reason,
      layout: layoutHintOf(row),
      children: [],
    }
    for (const c of childIndices[i]!) {
      if (nodeTypes[c] !== ELEMENT_NODE || pseudo.has(c) || SKIP_TAGS.has(tagOf(c))) continue
      node.children.push(build(c))
    }
    return node
  }

  return build(rootIdx)
}

async function handler(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const budgetTokens = typeof args.budgetTokens === 'number' && args.budgetTokens > 0 ? args.budgetTokens : 1500
  const includeInvisible = args.includeInvisible === true
  const scope = (args.scope ?? undefined) as TargetSpec | undefined

  let scopeBackendId: number | undefined
  if (scope !== undefined) {
    scopeBackendId = (await resolveTarget(ctx, scope)).backendNodeId
  }

  const baseParams: Protocol.DOMSnapshot.CaptureSnapshotRequest = {
    computedStyles: [...COMPUTED_WHITELIST],
    includePaintOrder: true,
    includeDOMRects: true,
  }
  let snap: Protocol.DOMSnapshot.CaptureSnapshotResponse
  try {
    // Blended colors / text opacities are experimental — older Chrome rejects the params (SPEC §9).
    snap = await ctx.cdp.send('DOMSnapshot.captureSnapshot', {
      ...baseParams,
      includeBlendedBackgroundColors: true,
      includeTextColorOpacities: true,
    })
  } catch {
    snap = await ctx.cdp.send('DOMSnapshot.captureSnapshot', baseParams)
  }

  const doc = snap.documents[0]
  if (!doc) throw new Error('DOMSnapshot returned no documents — is a page loaded?')

  const metrics = await ctx.cdp.send('Page.getLayoutMetrics')
  const lv = metrics.cssLayoutViewport ?? metrics.layoutViewport
  // Layout viewport in document coordinates — pageX/pageY carry the scroll offset.
  const viewport: Bounds = {
    x: lv?.pageX ?? 0,
    y: lv?.pageY ?? 0,
    width: lv?.clientWidth ?? 0,
    height: lv?.clientHeight ?? 0,
  }

  const root = snapshotToTree(ctx, doc, snap.strings, viewport, scopeBackendId)

  const titleIdx = doc.title
  const page: PageMeta = {
    url: ctx.page.url(),
    title: (titleIdx >= 0 ? snap.strings[titleIdx] : undefined) ?? '',
    viewport: { width: viewport.width, height: viewport.height },
  }

  // SPEC §8.1 platform suffix, e.g. "(WordPress 6.9, theme astra, builder elementor)".
  const platform = await detectPlatformFromPage(ctx.cdp, ctx.sheets.all())
  if (platform.platform) page.platform = platform

  let text = renderCensus(root, page, budgetTokens, includeInvisible)
  if (snap.documents.length > 1) {
    text += `\n[${snap.documents.length - 1} iframe document(s) not included — v0.1 snapshots the main document only]`
  }
  return { text }
}

export const pageSnapshotTool: ToolDef = {
  name: 'page_snapshot',
  description:
    'Pass-1 census of the rendered page: nested element tree with stable uids (e1, e2, …), geometry, ' +
    'visibility, and layout hints, token-budgeted. Invisible nodes are counted with reasons unless ' +
    'includeInvisible is set. Use scope to zoom into one subtree; uids feed every other tool.',
  inputSchema: {
    budgetTokens: z.number().int().positive().optional().describe('Output token budget (default 1500)'),
    scope: z
      .object({
        uid: z.string().optional().describe('Element uid from a prior snapshot, e.g. "e12"'),
        selector: z.string().optional().describe('CSS selector (first match)'),
        x: z.number().optional().describe('Viewport x coordinate'),
        y: z.number().optional().describe('Viewport y coordinate'),
      })
      .optional()
      .describe('Limit the census to one subtree; exactly one of uid | selector | x+y'),
    includeInvisible: z
      .boolean()
      .optional()
      .describe('Render invisible nodes inline with their reason (default false: counted, not shown)'),
  },
  handler,
}
