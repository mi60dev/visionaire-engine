/**
 * Stable uid registry (e1, e2, …) keyed by CDP backendNodeId, plus target resolution.
 * Same node → same uid for the lifetime of the page; clear() on navigation. SPEC §5.1.
 */
import type { Protocol } from 'puppeteer-core'
import type { ResolvedNode, TargetSpec, ToolContext, UidEntry, UidRegistryLike } from './types.js'
import { sanitizePageText } from './types.js'
import { selectorHelp } from './engine/suggest.js'

/**
 * The registry is the choke point where page-derived strings enter tool output —
 * sanitize here (untrusted pages can carry instruction-shaped text in element
 * text, class names, and ids aimed at the calling LLM).
 */
function sanitizeMeta(
  meta: Partial<Omit<UidEntry, 'uid' | 'backendNodeId'>>,
): Partial<Omit<UidEntry, 'uid' | 'backendNodeId'>> {
  const out: Partial<Omit<UidEntry, 'uid' | 'backendNodeId'>> = {}
  if (meta.tag !== undefined) out.tag = sanitizePageText(meta.tag, 60)
  if (meta.attrId !== undefined) out.attrId = sanitizePageText(meta.attrId, 60)
  if (meta.classes !== undefined) out.classes = meta.classes.map((c) => sanitizePageText(c, 60))
  if (meta.textPreview !== undefined) out.textPreview = sanitizePageText(meta.textPreview, 40)
  return out
}

export class UidRegistry implements UidRegistryLike {
  private byUid = new Map<string, UidEntry>()
  private byBackend = new Map<number, string>()
  private counter = 0

  assign(backendNodeId: number, meta: Partial<Omit<UidEntry, 'uid' | 'backendNodeId'>> = {}): string {
    const clean = sanitizeMeta(meta)
    const existing = this.byBackend.get(backendNodeId)
    if (existing) {
      const entry = this.byUid.get(existing)!
      Object.assign(entry, clean)
      return existing
    }
    const uid = `e${++this.counter}`
    this.byBackend.set(backendNodeId, uid)
    this.byUid.set(uid, { uid, backendNodeId, ...clean })
    return uid
  }

  get(uid: string): UidEntry | undefined {
    return this.byUid.get(uid)
  }

  byBackendId(backendNodeId: number): string | undefined {
    return this.byBackend.get(backendNodeId)
  }

  clear(): void {
    this.byUid.clear()
    this.byBackend.clear()
    this.counter = 0
  }
}

/**
 * Resolve a TargetSpec (uid | selector | x,y) to a live node.
 * Throws with an actionable message when the target is missing or stale.
 */
export async function resolveTarget(ctx: ToolContext, target: TargetSpec): Promise<ResolvedNode> {
  const given = [target.uid, target.selector, target.x !== undefined ? 'xy' : undefined].filter(
    (v) => v !== undefined,
  )
  if (given.length !== 1) {
    throw new Error('Provide exactly one of: uid, selector, or x+y coordinates.')
  }

  if (target.uid !== undefined) {
    const entry = ctx.uids.get(target.uid)
    if (!entry) {
      throw new Error(
        `Unknown uid "${target.uid}" — it may be stale after navigation. Take a fresh page_snapshot.`,
      )
    }
    const { nodeIds } = (await ctx.cdp.send('DOM.pushNodesByBackendIdsToFrontend', {
      backendNodeIds: [entry.backendNodeId],
    })) as Protocol.DOM.PushNodesByBackendIdsToFrontendResponse
    const nodeId = nodeIds[0]
    if (!nodeId) {
      throw new Error(`uid "${target.uid}" no longer resolves to a live node. Take a fresh page_snapshot.`)
    }
    return { uid: target.uid, backendNodeId: entry.backendNodeId, nodeId }
  }

  // Selector and coordinate paths both need the document root.
  const doc = (await ctx.cdp.send('DOM.getDocument', { depth: 0 })) as Protocol.DOM.GetDocumentResponse

  let nodeId: Protocol.DOM.NodeId
  if (target.selector !== undefined) {
    let res: Protocol.DOM.QuerySelectorResponse
    try {
      res = (await ctx.cdp.send('DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector: target.selector,
      })) as Protocol.DOM.QuerySelectorResponse
    } catch {
      // CDP rejects malformed selectors — report that clearly rather than as "no match".
      throw new Error(`Invalid CSS selector: ${target.selector}`)
    }
    if (!res.nodeId) {
      const help = await selectorHelp(ctx, target.selector)
      throw new Error(`No element matches selector "${target.selector}". ${help}`)
    }
    nodeId = res.nodeId
  } else {
    const res = (await ctx.cdp.send('DOM.getNodeForLocation', {
      x: Math.round(target.x!),
      y: Math.round(target.y!),
      includeUserAgentShadowDOM: false,
    })) as Protocol.DOM.GetNodeForLocationResponse
    if (!res.backendNodeId) throw new Error(`No element at (${target.x}, ${target.y}).`)
    const pushed = (await ctx.cdp.send('DOM.pushNodesByBackendIdsToFrontend', {
      backendNodeIds: [res.backendNodeId],
    })) as Protocol.DOM.PushNodesByBackendIdsToFrontendResponse
    nodeId = pushed.nodeIds[0]!
  }

  const described = (await ctx.cdp.send('DOM.describeNode', {
    nodeId,
  })) as Protocol.DOM.DescribeNodeResponse
  const backendNodeId = described.node.backendNodeId
  const attrs = pairAttributes(described.node.attributes)
  const uid = ctx.uids.assign(backendNodeId, {
    tag: described.node.nodeName.toLowerCase(),
    classes: (attrs.get('class') ?? '').split(/\s+/).filter(Boolean),
    attrId: attrs.get('id'),
  })
  return { uid, backendNodeId, nodeId }
}

/** CDP returns attributes as a flat [name, value, name, value, …] array. */
export function pairAttributes(flat: string[] | undefined): Map<string, string> {
  const map = new Map<string, string>()
  if (!flat) return map
  for (let i = 0; i + 1 < flat.length; i += 2) map.set(flat[i]!, flat[i + 1]!)
  return map
}
