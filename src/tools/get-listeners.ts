/**
 * get_listeners — SPEC §14.2. resolveTarget → DOM.resolveNode → objectId →
 * DOMDebugger.getEventListeners for the element, its ancestor chain (one
 * in-page hop, ending at the document), and window; handler locations resolve
 * through the ScriptRegistry (§14.1) and delegation frameworks are labeled
 * honestly instead of pretending to find the component handler.
 *
 * Empirically verified against real Chrome (headless, file:// pages):
 *  - EventListener payloads carry scriptId/lineNumber/columnNumber (0-based)
 *    but NO handler RemoteObject — function names are recovered from
 *    Debugger.getScriptSource: the reported position points exactly at the
 *    "(" of the parameter list, so the identifier ending there is the name
 *    (works for declarations, bound originals, and handleEvent methods;
 *    anonymous/arrow handlers yield none and render as plain "handler").
 *  - Inline on*-attribute handlers compile eagerly as their own script with
 *    url == document URL and DOCUMENT-relative positions, while
 *    getScriptSource returns only the attribute body — so the "(" guard
 *    rejects name recovery there, and the listener is detected via the
 *    owner's on<type> attribute + script url == page url and rendered as
 *    "inline onclick attribute".
 *  - window listeners carry no backendNodeId → pseudo-uid 'window'; the
 *    parentNode walk reaches the #document node (nodeType 9) → 'document'.
 */
import type { Protocol } from 'puppeteer-core'
import { z } from 'zod'
import { classifyDelegation } from '../attribution/scripts.js'
import type { ListenerInfo, TargetSpec, ToolContext, ToolDef } from '../types.js'
import { resolveTarget } from '../uid.js'

const OBJECT_GROUP = 'visionaire-get-listeners'
const MAX_ANCESTOR_LINES = 12

/** Events whose passive flag governs scroll blocking — spell passive out for these ALWAYS (SPEC §14.2). */
const SCROLL_BLOCKING_EVENTS = new Set(['wheel', 'mousewheel', 'touchstart', 'touchmove'])

const MINIFIED_FILENAME = /\.min\./

/** Identifiers the name scan-back must reject (position after a keyword ≠ a function name). */
const JS_KEYWORDS = new Set([
  'function', 'async', 'return', 'await', 'yield', 'new', 'typeof', 'void', 'delete',
  'in', 'of', 'instanceof', 'if', 'else', 'do', 'while', 'for', 'switch', 'case',
  'throw', 'catch',
])

const inputSchema = {
  uid: z.string().optional().describe('Element uid from a prior page_snapshot (e.g. "e8")'),
  selector: z.string().optional().describe('CSS selector — first match is used'),
  x: z.number().optional().describe('Viewport x coordinate (use with y)'),
  y: z.number().optional().describe('Viewport y coordinate (use with x)'),
  eventType: z.string().optional().describe('Filter to one event type, e.g. "click"'),
  includeAncestors: z
    .boolean()
    .optional()
    .describe(
      'Also report listeners up the ancestor chain, document, and window (default true) — delegated handlers live there',
    ),
}

function targetFromArgs(args: Record<string, unknown>): TargetSpec {
  return {
    uid: typeof args.uid === 'string' ? args.uid : undefined,
    selector: typeof args.selector === 'string' ? args.selector : undefined,
    x: typeof args.x === 'number' ? args.x : undefined,
    y: typeof args.y === 'number' ? args.y : undefined,
  }
}

interface ChainItem {
  tag?: string
  classes?: string[]
  id?: string
  text?: string
  /** Lowercased on* attribute names present on the node (inline-handler detection). */
  onAttrs?: string[]
  /** True for the #document entry that terminates the chain. */
  doc?: boolean
}

/**
 * Like node-at-point's CHAIN_FN, but continues past <html> to the #document
 * node (document-level delegation lives there) and collects on* attribute
 * names per node. Text-node hits resolve to the parent element; shadow roots
 * are escaped host-ward, mirroring event propagation.
 */
const CHAIN_FN = `function () {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  let el = this.nodeType === 1 ? this : this.parentElement;
  const chain = [];
  let cur = el;
  while (cur) {
    chain.push(cur);
    if (cur.nodeType === 9) break;
    let next = cur.parentNode;
    if (next && next.nodeType === 11 && next.host) next = next.host;
    if (!next && cur.getRootNode) {
      const root = cur.getRootNode();
      next = root && root.host ? root.host : null;
    }
    cur = next;
  }
  const items = chain.map((e, i) => {
    if (e.nodeType === 9) return { doc: true };
    const o = { tag: e.tagName.toLowerCase(), classes: Array.prototype.slice.call(e.classList, 0, 3) };
    if (e.id) o.id = e.id;
    const on = [];
    const attrs = e.attributes ? Array.prototype.slice.call(e.attributes) : [];
    for (const a of attrs) { if (a.name.toLowerCase().indexOf('on') === 0) on.push(a.name.toLowerCase()); }
    if (on.length) o.onAttrs = on;
    if (i === 0) {
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

// Local copy of the unpack idiom used by node-at-point/pick-element (module-local there).
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
  if (indexed.length === 0) throw new Error('ancestor walk returned a malformed result')
  const metaJson = String(indexed[0].value!.value ?? '{}')
  const objectIds = indexed
    .slice(1)
    .map((p) => p.value!.objectId)
    .filter((id): id is string => typeof id === 'string')
  return { metaJson, objectIds }
}

/** One level that can carry listeners: the element, an ancestor, document, or window. */
interface ListenerOwner {
  /** 'document' / 'window' pseudo-uids, else an eN uid (SPEC §14.2). */
  uid: string
  /** Rendered identity, e.g. `e3 <button#direct-btn.btn>`, `document`, `window`. */
  label: string
  objectId: string
  onAttrs: Set<string>
}

function identity(uid: string, item: ChainItem): string {
  const id = item.id ? `#${item.id}` : ''
  const cls = (item.classes ?? []).map((c) => `.${c}`).join('')
  return `${uid} <${item.tag}${id}${cls}>`
}

/** Last path segments only — full URLs blow the token budget (SPEC §5 principle 5). */
function shortUrl(url: string): string {
  let path: string
  try {
    path = new URL(url).pathname
  } catch {
    path = url.split(/[?#]/)[0] ?? url
  }
  const segs = path.split('/').filter(Boolean)
  if (segs.length === 0) return url
  return segs.length <= 2 ? segs.join('/') : `…/${segs.slice(-2).join('/')}`
}

function stripHash(url: string): string {
  return url.split('#')[0] ?? url
}

/**
 * Recover the handler's function name from script source. The listener
 * position sits at the "(" of the parameter list (verified empirically), so
 * the identifier ending there is the name; the "(" guard also rejects scripts
 * whose positions are not source-relative (inline on*-attribute scripts are
 * document-relative).
 */
async function recoverFunctionName(
  ctx: ToolContext,
  scriptId: string,
  line0: number,
  col0: number,
  cache: Map<string, string[] | null>,
): Promise<string | undefined> {
  let lines = cache.get(scriptId)
  if (lines === undefined) {
    try {
      const res = await ctx.cdp.send('Debugger.getScriptSource', { scriptId })
      lines = res.scriptSource.split('\n')
    } catch {
      lines = null
    }
    cache.set(scriptId, lines)
  }
  if (!lines) return undefined
  const lineText = lines[line0]
  if (lineText === undefined || lineText[col0] !== '(') return undefined
  const before = lineText.slice(Math.max(0, col0 - 80), col0)
  const name = /([A-Za-z_$][\w$]*)\s*$/.exec(before)?.[1]
  if (!name || JS_KEYWORDS.has(name)) return undefined
  return name
}

/** ListenerInfo + the render-only facts that do not belong in the shared contract. */
interface RenderedListener {
  info: ListenerInfo
  isInlineAttribute: boolean
  unresolved: boolean
}

async function collectListeners(
  ctx: ToolContext,
  owner: ListenerOwner,
  pageUrl: string,
  eventType: string | undefined,
  sourceCache: Map<string, string[] | null>,
): Promise<RenderedListener[]> {
  let raw: Protocol.DOMDebugger.GetEventListenersResponse
  try {
    raw = await ctx.cdp.send('DOMDebugger.getEventListeners', { objectId: owner.objectId })
  } catch {
    return [] // e.g. a node type the domain rejects — treat as no listeners
  }
  const out: RenderedListener[] = []
  for (const l of raw.listeners) {
    if (eventType !== undefined && l.type !== eventType) continue
    const location = await ctx.scripts!.resolvePosition(l.scriptId, l.lineNumber, l.columnNumber)
    const unresolved = location === undefined || location.url === ''
    const isInlineAttribute =
      !unresolved && owner.onAttrs.has(`on${l.type}`) && stripHash(location!.url) === stripHash(pageUrl)
    if (!unresolved && !isInlineAttribute && location!.functionName === undefined) {
      const name = await recoverFunctionName(ctx, l.scriptId, l.lineNumber, l.columnNumber, sourceCache)
      if (name !== undefined) location!.functionName = name
    }
    const info: ListenerInfo = {
      eventType: l.type,
      capture: l.useCapture,
      passive: l.passive,
      once: l.once,
      ownerUid: owner.uid,
    }
    if (location !== undefined) info.location = location
    const delegatedBy = unresolved ? undefined : classifyDelegation(location!.url)
    if (delegatedBy !== undefined) info.delegatedBy = delegatedBy
    out.push({ info, isInlineAttribute, unresolved })
  }
  return out
}

/** Flags only when non-default; passive is ALWAYS spelled out for scroll-blocking events (SPEC §14.2). */
function flagString(info: ListenerInfo): string {
  const parts: string[] = []
  if (info.capture) parts.push('capture')
  if (info.once) parts.push('once')
  if (SCROLL_BLOCKING_EVENTS.has(info.eventType)) {
    parts.push(
      info.passive
        ? 'passive:true — preventDefault is silently ignored'
        : 'passive:false — can block scrolling',
    )
  } else if (info.passive) {
    parts.push('passive:true — preventDefault is silently ignored')
  }
  return parts.length > 0 ? `  (${parts.join(', ')})` : ''
}

/** `click → handleX @ …/js/a.js:7  [line | plugin: x]  (flags)  delegated (jquery)` — SPEC §14.2 format. */
function renderListener(r: RenderedListener): string {
  const { info } = r
  const loc = info.location
  let what: string
  let at: string
  let bracket: string
  if (r.unresolved || loc === undefined) {
    what = 'handler'
    at = '<unknown script — reconnect and re-navigate to rebuild JS attribution>'
    bracket = ''
  } else if (r.isInlineAttribute) {
    what = `inline on${info.eventType} attribute`
    at = `${shortUrl(loc.url)}:${loc.line}`
    bracket = '  [line — edit the HTML attribute]'
  } else {
    what = loc.functionName ?? 'handler'
    if (loc.authored) {
      at = `${loc.authored.file}:${loc.authored.line}`
      bracket = `  [line via source map${loc.originLabel ? ` | ${loc.originLabel}` : ''}]`
    } else {
      at = `${shortUrl(loc.url)}:${loc.line}`
      const minified = MINIFIED_FILENAME.test(shortUrl(loc.url))
      const gran = minified ? 'file' : 'line'
      const minNote = minified ? ' — minified, no map' : ''
      bracket = `  [${gran}${loc.originLabel ? ` | ${loc.originLabel}` : ''}${minNote}]`
    }
  }
  const delegated = info.delegatedBy ? `  delegated (${info.delegatedBy})` : ''
  return `${info.eventType} → ${what} @ ${at}${bracket}${flagString(info)}${delegated}`
}

export const getListenersTool: ToolDef = {
  name: 'get_listeners',
  description:
    'Event listeners on an element with handler file:line attribution — the bridge from "this button" ' +
    'to "this JS file". Reports capture/passive/once flags (passive:true silently disables preventDefault), ' +
    'walks the ancestor chain + document + window for delegated handlers, and labels delegation frameworks ' +
    '(jquery, react-dom, vue) honestly. Target by uid, CSS selector, or viewport x+y; ' +
    'filter with eventType (e.g. "click").',
  inputSchema,
  handler: async (ctx, args) => {
    if (!ctx.scripts) {
      throw new Error(
        'JS attribution is unavailable in this session (no ScriptRegistry) — reconnect to enable JS attribution.',
      )
    }
    const eventType = typeof args.eventType === 'string' ? args.eventType : undefined
    const includeAncestors = args.includeAncestors !== false
    const node = await resolveTarget(ctx, targetFromArgs(args))
    const pageUrl = ctx.page.url()

    try {
      const { object } = await ctx.cdp.send('DOM.resolveNode', {
        backendNodeId: node.backendNodeId,
        objectGroup: OBJECT_GROUP,
      })
      if (!object.objectId) {
        throw new Error(`the target node could not be resolved to an object — take a fresh page_snapshot`)
      }
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
        throw new Error('the target is a non-element node with no element ancestor')
      }

      // Chain items → owners (uids for elements; 'document' pseudo-uid at the end).
      const owners: ListenerOwner[] = []
      const n = Math.min(objectIds.length, items.length)
      for (let i = 0; i < n; i++) {
        const item = items[i]
        const objectId = objectIds[i]
        if (item.doc) {
          owners.push({ uid: 'document', label: 'document', objectId, onAttrs: new Set() })
          continue
        }
        const described = await ctx.cdp.send('DOM.describeNode', { objectId })
        const uid = ctx.uids.assign(described.node.backendNodeId, {
          tag: item.tag,
          classes: item.classes,
          attrId: item.id,
          textPreview: item.text,
        })
        owners.push({ uid, label: identity(uid, item), objectId, onAttrs: new Set(item.onAttrs ?? []) })
      }
      if (includeAncestors) {
        const win = await ctx.cdp.send('Runtime.evaluate', {
          expression: 'window',
          objectGroup: OBJECT_GROUP,
        })
        if (win.result.objectId) {
          owners.push({ uid: 'window', label: 'window', objectId: win.result.objectId, onAttrs: new Set() })
        }
      }

      const sourceCache = new Map<string, string[] | null>()
      const target = owners[0]
      const levels = includeAncestors ? owners : [target]
      const byOwner: Array<{ owner: ListenerOwner; listeners: RenderedListener[] }> = []
      for (const owner of levels) {
        byOwner.push({
          owner,
          listeners: await collectListeners(ctx, owner, pageUrl, eventType, sourceCache),
        })
      }

      // ── Render ──
      const targetItem = items[0]
      const text = targetItem.text ? ` "${targetItem.text}"` : ''
      const filterNote = eventType !== undefined ? ` — ${eventType} only` : ''
      const lines: string[] = [`listeners on ${target.label}${text}${filterNote}`]

      const own = byOwner[0].listeners
      if (own.length === 0) {
        lines.push(
          `  (none${eventType !== undefined ? ` for ${eventType}` : ''} on the element itself${
            includeAncestors ? ' — delegated handlers may live on the ancestors below' : ''
          })`,
        )
      } else {
        for (const r of own) lines.push(`  ${renderListener(r)}`)
      }

      if (includeAncestors) {
        lines.push(`ancestors${eventType !== undefined ? ` (${eventType})` : ''}:`)
        const ancestorLines: string[] = []
        for (const { owner, listeners } of byOwner.slice(1)) {
          if (listeners.length === 0) continue // skip levels with no listeners (SPEC §14.2)
          for (const r of listeners) {
            ancestorLines.push(
              eventType !== undefined
                ? `  ${owner.label} ${renderListener(r).replace(`${r.info.eventType} → `, '→ ')}`
                : `  ${owner.label}: ${renderListener(r)}`,
            )
          }
        }
        if (ancestorLines.length === 0) {
          lines.push('  (none up the chain — document and window included)')
        } else if (ancestorLines.length > MAX_ANCESTOR_LINES) {
          lines.push(...ancestorLines.slice(0, MAX_ANCESTOR_LINES))
          lines.push(
            `  [+${ancestorLines.length - MAX_ANCESTOR_LINES} more ancestor listeners — narrow with eventType]`,
          )
        } else {
          lines.push(...ancestorLines)
        }
      }

      const frameworks = [
        ...new Set(byOwner.flatMap((o) => o.listeners.map((r) => r.info.delegatedBy)).filter(Boolean)),
      ]
      if (frameworks.length > 0) {
        lines.push(
          `note: delegated root listener (${frameworks.join(', ')}) — component handler not resolvable ` +
            'at the DOM level; read the component source',
        )
      }
      return { text: lines.join('\n') }
    } finally {
      await ctx.cdp.send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => {})
    }
  },
}
