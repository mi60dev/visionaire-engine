/**
 * pick_element — SPEC §4 #13. Human-in-the-loop grounding: Overlay.setInspectMode
 * gives the connected tab a DevTools-style hover highlight; the user clicks the
 * broken element; Overlay.inspectNodeRequested carries the backendNodeId, which
 * we resolve to a uid plus the ancestor uid chain.
 */
import type { Protocol } from 'puppeteer-core'
import { z } from 'zod'
import type { ToolContext, ToolDef } from '../types.js'

const OBJECT_GROUP = 'visionaire-pick-element'

const DEFAULT_TIMEOUT_S = 60
const MIN_TIMEOUT_S = 5
const MAX_TIMEOUT_S = 600

const inputSchema = {
  timeoutSeconds: z
    .number()
    .optional()
    .describe(
      `How long to wait for the user's click; default ${DEFAULT_TIMEOUT_S}, clamped to ${MIN_TIMEOUT_S}–${MAX_TIMEOUT_S}`,
    ),
}

const argsSchema = z.object(inputSchema)

/** DevTools-like hover highlight: distinct box fills per box-model layer + the info tooltip. */
const HIGHLIGHT_CONFIG: Protocol.Overlay.HighlightConfig = {
  showInfo: true,
  showStyles: false,
  showRulers: false,
  showExtensionLines: false,
  contentColor: { r: 111, g: 168, b: 220, a: 0.66 },
  paddingColor: { r: 147, g: 196, b: 125, a: 0.55 },
  borderColor: { r: 255, g: 229, b: 153, a: 0.66 },
  marginColor: { r: 246, g: 178, b: 107, a: 0.66 },
}

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

// Local copy of node-at-point's ancestor walk (it is not exported there).
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

/** backendNodeId (from the pick event) → identity line + ancestor uid chain + next-step hint. */
async function describePicked(ctx: ToolContext, backendNodeId: number): Promise<string> {
  try {
    const { object } = await ctx.cdp.send('DOM.resolveNode', {
      backendNodeId,
      objectGroup: OBJECT_GROUP,
    })
    if (!object.objectId) throw new Error('the picked node could not be resolved to an object')
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
      throw new Error('the pick landed on a non-element node with no element ancestor')
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
    const chain = entries.map((e) => chainEntry(e.uid, e.item)).join(' < ')
    return [
      `picked: ${first.uid} <${first.item.tag}${id}${cls}>${text}${geom}`,
      `chain: ${chain}`,
      `next: explain_styles { uid: "${first.uid}" } or inspect_element { uid: "${first.uid}" }`,
    ].join('\n')
  } finally {
    await ctx.cdp.send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => {})
  }
}

export const pickElementTool: ToolDef = {
  name: 'pick_element',
  description:
    'Turn on a DevTools-style hover highlight in the connected tab and wait for the user to click the element that looks wrong; returns its uid, identity, and ancestor uid chain. Use when the user offers to point at the element ("I\'ll show you", "let me click it") or when verbal/screenshot grounding failed. Needs a visible window (connect { headless: false }).',
  inputSchema,
  handler: async (ctx, args) => {
    const a = argsSchema.parse(args)
    const timeoutSeconds = Math.min(
      MAX_TIMEOUT_S,
      Math.max(MIN_TIMEOUT_S, a.timeoutSeconds ?? DEFAULT_TIMEOUT_S),
    )

    // Chrome ≥149 reports product "Chrome/xxx" even when headless; the browser-level
    // userAgent still reads "HeadlessChrome/xxx". Check both (older Chrome: product).
    const browser = ctx.page.browser()
    const headless =
      (await browser.version()).includes('Headless') || (await browser.userAgent()).includes('Headless')
    const warning = headless
      ? 'warning: headless session — no human can see this tab to click in it (synthetic Input.dispatchMouseEvent clicks still work); use connect { headless: false } for a real picker.\n'
      : ''

    let timer: ReturnType<typeof setTimeout> | undefined
    let onPick: ((event: Protocol.Overlay.InspectNodeRequestedEvent) => void) | undefined
    let picked: Protocol.Overlay.InspectNodeRequestedEvent | undefined
    try {
      await ctx.cdp.send('Overlay.setInspectMode', {
        mode: 'searchForNode',
        highlightConfig: HIGHLIGHT_CONFIG,
      })
      picked = await new Promise<Protocol.Overlay.InspectNodeRequestedEvent | undefined>((resolve) => {
        onPick = resolve
        ctx.cdp.once('Overlay.inspectNodeRequested', onPick)
        timer = setTimeout(() => resolve(undefined), timeoutSeconds * 1000)
      })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (onPick !== undefined) ctx.cdp.off('Overlay.inspectNodeRequested', onPick)
      // ALWAYS exit inspect mode. The protocol types mark highlightConfig optional for
      // 'none', but Chrome 149 rejects the call without it ("highlight configuration
      // parameter is missing") — send an empty config.
      await ctx.cdp.send('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} }).catch(() => {})
    }

    if (!picked) {
      return {
        text:
          `${warning}no element was picked within ${timeoutSeconds}s — is someone looking at the browser window? ` +
          'Ask the user to click the element that looks wrong, then call pick_element again ' +
          '(raise timeoutSeconds if they need more time).',
      }
    }

    return { text: warning + (await describePicked(ctx, picked.backendNodeId)) }
  },
}
