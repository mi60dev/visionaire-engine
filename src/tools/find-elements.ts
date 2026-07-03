/**
 * find_elements — SPEC §4 #9. A single Runtime.evaluate walks the DOM in-page
 * with all criteria AND-combined. DOM nodes cannot cross returnByValue, so the
 * result is an array whose slot 0 is a JSON metadata string and slots 1..n are
 * the matched elements, unpacked via Runtime.getProperties → DOM.describeNode.
 */
import type { Protocol } from 'puppeteer-core'
import { z } from 'zod'
import type { ToolContext, ToolDef } from '../types.js'
import { selectorHelp } from '../engine/suggest.js'

const OBJECT_GROUP = 'visionaire-find-elements'

const inputSchema = {
  text: z.string().optional().describe("Case-insensitive substring of the element's own text"),
  selector: z.string().optional().describe('CSS selector, matched via querySelectorAll'),
  role: z
    .string()
    .optional()
    .describe('ARIA role: explicit [role] attribute or tag-implied (link, button, heading, navigation, …)'),
  region: z
    .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
    .optional()
    .describe('Viewport rectangle (CSS px) the element must intersect'),
  visibleOnly: z.boolean().default(true),
  limit: z.number().int().min(1).max(100).default(10),
}

const argsSchema = z.object(inputSchema)

interface MatchItem {
  tag: string
  classes: string[]
  id?: string
  text?: string
  x: number
  y: number
  w: number
  h: number
}

function searchExpression(crit: z.infer<typeof argsSchema>): string {
  return `(() => {
  const crit = ${JSON.stringify(crit)};
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const textOf = (el) => norm(el.innerText !== undefined ? el.innerText : el.textContent);
  const visible = (el) => {
    if (typeof el.checkVisibility === 'function') {
      // Chrome <121 spells the options checkOpacity/checkVisibilityCSS; newer spec names are also passed. Unknown dict members are ignored.
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true });
    }
    const s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility === 'visible' && Number(s.opacity) !== 0;
  };
  const roleOf = (el) => {
    const attr = el.getAttribute('role');
    if (attr) return attr.trim().toLowerCase();
    const t = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(t)) return 'heading';
    if (t === 'input') {
      const ty = (el.getAttribute('type') || 'text').toLowerCase();
      const inputMap = { button: 'button', submit: 'button', reset: 'button', image: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider' };
      return inputMap[ty] || 'textbox';
    }
    const map = { a: 'link', button: 'button', img: 'img', nav: 'navigation', header: 'banner', footer: 'contentinfo', main: 'main', section: 'region', article: 'article', aside: 'complementary', form: 'form', select: 'combobox', textarea: 'textbox', ul: 'list', ol: 'list', li: 'listitem', table: 'table' };
    return map[t];
  };
  const root = document.body || document.documentElement;
  let els = Array.from(crit.selector ? document.querySelectorAll(crit.selector) : root.querySelectorAll('*'));
  if (crit.role) {
    const want = crit.role.trim().toLowerCase();
    els = els.filter((el) => roleOf(el) === want);
  }
  if (crit.region) {
    const g = crit.region;
    els = els.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.left < g.x + g.width && r.right > g.x && r.top < g.y + g.height && r.bottom > g.y;
    });
  }
  if (crit.visibleOnly) els = els.filter(visible);
  if (crit.text) {
    const needle = crit.text.toLowerCase();
    const matching = els.filter((el) => textOf(el).toLowerCase().includes(needle));
    // Prefer elements whose OWN text nodes contain the needle; else keep only the deepest matches
    // (drop any match that contains another match) so wrappers do not shadow the real hit.
    const own = matching.filter((el) =>
      Array.prototype.some.call(el.childNodes, (n) => n.nodeType === 3 && norm(n.textContent).toLowerCase().includes(needle)));
    els = own.length ? own : matching.filter((el) => !matching.some((o) => o !== el && el.contains(o)));
  }
  const total = els.length;
  const kept = els.slice(0, crit.limit);
  const items = kept.map((el) => {
    const r = el.getBoundingClientRect();
    const o = {
      tag: el.tagName.toLowerCase(),
      classes: Array.prototype.slice.call(el.classList, 0, 3),
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    };
    if (el.id) o.id = el.id;
    const t = textOf(el).slice(0, 30);
    if (t) o.text = t;
    return o;
  });
  return [JSON.stringify({ total: total, items: items })].concat(kept);
})()`
}

function describeException(details: Protocol.Runtime.ExceptionDetails): string {
  return details.exception?.description?.split('\n')[0] ?? details.text
}

function identityOf(item: { tag: string; classes: string[]; id?: string }): string {
  const id = item.id ? `#${item.id}` : ''
  return `<${item.tag}${id}${item.classes.map((c) => `.${c}`).join('')}>`
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
  if (indexed.length === 0) throw new Error('in-page search returned a malformed result')
  const metaJson = String(indexed[0].value!.value ?? '{}')
  const objectIds = indexed
    .slice(1)
    .map((p) => p.value!.objectId)
    .filter((id): id is string => typeof id === 'string')
  return { metaJson, objectIds }
}

export const findElementsTool: ToolDef = {
  name: 'find_elements',
  description:
    'Deterministically search the page by text, CSS selector, role, and/or viewport region (criteria AND-combined). Returns compact uid-keyed matches for use with the other tools.',
  inputSchema,
  handler: async (ctx, args) => {
    const a = argsSchema.parse(args)
    if (!a.text && !a.selector && !a.role && a.region === undefined) {
      throw new Error('Provide at least one criterion: text, selector, role, or region.')
    }
    try {
      const evaluated = await ctx.cdp.send('Runtime.evaluate', {
        expression: searchExpression(a),
        objectGroup: OBJECT_GROUP,
      })
      if (evaluated.exceptionDetails) {
        throw new Error(`search failed in page: ${describeException(evaluated.exceptionDetails)}`)
      }
      if (!evaluated.result.objectId) {
        throw new Error('search returned no result (page may be navigating) — retry after the page settles')
      }
      const { metaJson, objectIds } = await unpackNodeArray(ctx, evaluated.result.objectId)
      const meta = JSON.parse(metaJson) as { total: number; items: MatchItem[] }

      if (meta.total === 0) {
        const hint = a.visibleOnly ? 'try visibleOnly: false or fewer criteria' : 'try fewer criteria'
        // A guessed selector that matches nothing is the common failure — offer live near-misses.
        const suggestion =
          typeof a.selector === 'string' && a.selector
            ? ` ${await selectorHelp(ctx, a.selector)}`
            : ' Take a page_snapshot to see the real element tree, or read the project source for actual names.'
        return { text: `no elements matched (criteria are AND-combined; ${hint}).${suggestion}` }
      }

      const lines: string[] = []
      const n = Math.min(objectIds.length, meta.items.length)
      for (let i = 0; i < n; i++) {
        const described = await ctx.cdp.send('DOM.describeNode', { objectId: objectIds[i] })
        const item = meta.items[i]
        const uid = ctx.uids.assign(described.node.backendNodeId, {
          tag: item.tag,
          classes: item.classes,
          attrId: item.id,
          textPreview: item.text,
        })
        const text = item.text ? `"${item.text}" ` : ''
        lines.push(`${uid} ${identityOf(item)} ${text}${item.w}x${item.h} @(${item.x},${item.y})`)
      }
      const header =
        meta.total > lines.length
          ? `${meta.total} elements found — showing first ${lines.length} (raise limit or narrow criteria):`
          : `${meta.total} element${meta.total === 1 ? '' : 's'} found:`
      return { text: [header, ...lines].join('\n') }
    } finally {
      await ctx.cdp.send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => {})
    }
  },
}
