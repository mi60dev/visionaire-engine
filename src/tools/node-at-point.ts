/**
 * node_at_point — SPEC §4 #10. DOM.getNodeForLocation grounds a viewport
 * coordinate to a backendNodeId; one Runtime.callFunctionOn then returns the
 * hit element plus its full ancestor chain so every hop gets a uid.
 */
import type { Protocol } from 'puppeteer-core'
import { z } from 'zod'
import type { ToolContext, ToolDef } from '../types.js'

const OBJECT_GROUP = 'visionaire-node-at-point'

const inputSchema = {
  x: z.number().describe('Viewport x in CSS px'),
  y: z.number().describe('Viewport y in CSS px'),
}

const argsSchema = z.object(inputSchema)

interface ChainItem {
  tag: string
  classes: string[]
  id?: string
  text?: string
  x?: number
  y?: number
  w?: number
  h?: number
}

// Text-node hits resolve to the parent element; the chain escapes shadow roots via getRootNode().host.
const CHAIN_FN = `function () {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  let el = this.nodeType === 1 ? this : this.parentElement;
  const chain = [];
  while (el && el.nodeType === 1) {
    chain.push(el);
    if (el.tagName === 'BODY' || el.tagName === 'HTML') break;
    const root = el.getRootNode ? el.getRootNode() : null;
    el = el.parentElement || (root && root.host ? root.host : null);
  }
  const items = chain.map((e, i) => {
    const o = { tag: e.tagName.toLowerCase(), classes: Array.prototype.slice.call(e.classList, 0, 3) };
    if (e.id) o.id = e.id;
    if (i === 0) {
      const r = e.getBoundingClientRect();
      o.x = Math.round(r.x); o.y = Math.round(r.y); o.w = Math.round(r.width); o.h = Math.round(r.height);
      const t = norm(e.innerText !== undefined ? e.innerText : e.textContent).slice(0, 30);
      if (t) o.text = t;
    }
    return o;
  });
  return [JSON.stringify({ items: items })].concat(chain);
}`

function describeException(details: Protocol.Runtime.ExceptionDetails): string {
  return details.exception?.description?.split('\n')[0] ?? details.text
}

async function unpackNodeArray(
  ctx: ToolContext,
  arrayObjectId: string,
): Promise<{ metaJson: string; objectIds: string[] }> {
  const props = await ctx.cdp.send('Runtime.getProperties', {
    objectId: arrayObjectId,
    ownProperties: true,
  })
  const indexed = props.result
    .filter((p) => /^\d+$/.test(p.name) && p.value !== undefined)
    .sort((a, b) => Number(a.name) - Number(b.name))
  if (indexed.length === 0) throw new Error('chain walk returned a malformed result')
  const metaJson = String(indexed[0].value!.value ?? '{}')
  const objectIds = indexed
    .slice(1)
    .map((p) => p.value!.objectId)
    .filter((id): id is string => typeof id === 'string')
  return { metaJson, objectIds }
}

function chainEntry(uid: string, item: ChainItem): string {
  const id = item.id ? `#${item.id}` : ''
  return `${uid} ${item.tag}${id}${item.classes.map((c) => `.${c}`).join('')}`
}

export const nodeAtPointTool: ToolDef = {
  name: 'node_at_point',
  description:
    'Map viewport coordinates (x, y) to the element at that point: uid, one-line identity, and the full ancestor uid chain for moving up when the hit is a text wrapper.',
  inputSchema,
  handler: async (ctx, args) => {
    const a = argsSchema.parse(args)
    let hit: Protocol.DOM.GetNodeForLocationResponse
    try {
      hit = await ctx.cdp.send('DOM.getNodeForLocation', {
        x: Math.round(a.x),
        y: Math.round(a.y),
        includeUserAgentShadowDOM: false,
      })
    } catch {
      throw new Error(`no element at (${a.x}, ${a.y}) — the point may be outside the viewport`)
    }
    try {
      const { object } = await ctx.cdp.send('DOM.resolveNode', {
        backendNodeId: hit.backendNodeId,
        objectGroup: OBJECT_GROUP,
      })
      if (!object.objectId) throw new Error(`node at (${a.x}, ${a.y}) could not be resolved to an object`)
      const call = await ctx.cdp.send('Runtime.callFunctionOn', {
        functionDeclaration: CHAIN_FN,
        objectId: object.objectId,
        objectGroup: OBJECT_GROUP,
      })
      if (call.exceptionDetails) {
        throw new Error(`ancestor walk failed: ${describeException(call.exceptionDetails)}`)
      }
      if (!call.result.objectId) throw new Error('ancestor walk returned no result')
      const { metaJson, objectIds } = await unpackNodeArray(ctx, call.result.objectId)
      const { items } = JSON.parse(metaJson) as { items: ChainItem[] }
      if (objectIds.length === 0 || items.length === 0) {
        throw new Error(`hit a non-element node at (${a.x}, ${a.y}) with no element ancestor`)
      }

      const entries: Array<{ uid: string; item: ChainItem }> = []
      const n = Math.min(objectIds.length, items.length)
      for (let i = 0; i < n; i++) {
        const described = await ctx.cdp.send('DOM.describeNode', { objectId: objectIds[i] })
        const item = items[i]
        const uid = ctx.uids.assign(described.node.backendNodeId, {
          tag: item.tag,
          classes: item.classes,
          attrId: item.id,
          textPreview: item.text,
        })
        entries.push({ uid, item })
      }

      const first = entries[0]
      const id = first.item.id ? `#${first.item.id}` : ''
      const cls = first.item.classes.map((c) => `.${c}`).join('')
      const text = first.item.text ? ` "${first.item.text}"` : ''
      const geom =
        first.item.w !== undefined ? ` ${first.item.w}x${first.item.h} @(${first.item.x},${first.item.y})` : ''
      const hitLine = `hit: ${first.uid} <${first.item.tag}${id}${cls}>${text}${geom}`
      const chain = entries.map((e) => chainEntry(e.uid, e.item)).join(' < ')
      return { text: `${hitLine} — chain: ${chain}` }
    } finally {
      await ctx.cdp.send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => {})
    }
  },
}
