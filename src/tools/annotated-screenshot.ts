/**
 * annotated_screenshot — SPEC §4 #11. Marks are burned in by injecting one
 * overlay container before Page.captureScreenshot and removing it in a finally
 * block. Mark numbers ARE the uid numbers (mark 17 = uid e17).
 */
import type { Protocol } from 'puppeteer-core'
import { z } from 'zod'
import type { ToolContext, ToolDef } from '../types.js'

const OBJECT_GROUP = 'visionaire-annotated-screenshot'
const DEFAULT_MAX_MARKS = 25

const inputSchema = {
  uids: z
    .array(z.string())
    .optional()
    .describe('Uids to mark; default: top ~25 visible interactive/landmark elements'),
  region: z
    .object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() })
    .optional()
    .describe('Clip to this viewport rectangle (CSS px)'),
  fullPage: z.boolean().default(false),
}

const argsSchema = z.object(inputSchema)

interface MeasuredElement {
  tag: string
  classes: string[]
  id?: string
  text?: string
  /** Viewport coords, rounded, at measure time. */
  x: number
  y: number
  w: number
  h: number
}

interface Mark extends MeasuredElement {
  uid: string
  label: string
}

const MEASURE_FN = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el) return null;
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const r = el.getBoundingClientRect();
  const o = {
    tag: el.tagName.toLowerCase(),
    classes: Array.prototype.slice.call(el.classList, 0, 3),
    x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
  };
  if (el.id) o.id = el.id;
  const t = norm(el.innerText !== undefined ? el.innerText : el.textContent).slice(0, 30);
  if (t) o.text = t;
  return o;
}`

function defaultMarksExpression(opts: {
  max: number
  viewportOnly: boolean
  region?: { x: number; y: number; width: number; height: number }
}): string {
  return `(() => {
  const opts = ${JSON.stringify(opts)};
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true });
    }
    const s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility === 'visible' && Number(s.opacity) !== 0;
  };
  const SEL = 'a, button, input, select, textarea, nav, header, footer, main, h1, h2, h3, [role="button"]';
  const vw = window.innerWidth, vh = window.innerHeight;
  const all = document.querySelectorAll(SEL);
  const els = [];
  for (let i = 0; i < all.length && els.length < opts.max; i++) {
    const el = all[i];
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (opts.region) {
      const g = opts.region;
      if (!(r.left < g.x + g.width && r.right > g.x && r.top < g.y + g.height && r.bottom > g.y)) continue;
    } else if (opts.viewportOnly) {
      if (!(r.left < vw && r.right > 0 && r.top < vh && r.bottom > 0)) continue;
    }
    els.push(el);
  }
  const items = els.map((el) => {
    const r = el.getBoundingClientRect();
    const o = {
      tag: el.tagName.toLowerCase(),
      classes: Array.prototype.slice.call(el.classList, 0, 3),
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    };
    if (el.id) o.id = el.id;
    const t = norm(el.innerText !== undefined ? el.innerText : el.textContent).slice(0, 30);
    if (t) o.text = t;
    return o;
  });
  return [JSON.stringify({ items: items })].concat(els);
})()`
}

/**
 * The overlay container is position:absolute in document coordinates (not
 * fixed): captureBeyondViewport / clipped captures render beyond the current
 * viewport, where fixed-position marks would land in the wrong place. Box
 * offsets subtract the container's own measured origin, which neutralizes
 * positioned/margined <body> containing-block offsets. Always returns the
 * current scroll offset (needed to convert the clip to document coords).
 */
function overlayExpression(marks: Array<{ label: string; x: number; y: number; w: number; h: number }>): string {
  return `(() => {
  const marks = ${JSON.stringify(marks)};
  document.querySelectorAll('[data-visionaire-overlay]').forEach((n) => n.remove());
  if (marks.length > 0) {
    const c = document.createElement('div');
    c.setAttribute('data-visionaire-overlay', '');
    c.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;margin:0;padding:0;border:0;pointer-events:none;z-index:2147483647;';
    (document.body || document.documentElement).appendChild(c);
    const cr = c.getBoundingClientRect();
    for (const m of marks) {
      const box = document.createElement('div');
      box.style.cssText = 'position:absolute;box-sizing:border-box;outline:2px solid #e91e63;outline-offset:-1px;pointer-events:none;'
        + 'left:' + (m.x - cr.left) + 'px;top:' + (m.y - cr.top) + 'px;width:' + m.w + 'px;height:' + m.h + 'px;';
      const label = document.createElement('div');
      label.textContent = m.label;
      label.style.cssText = 'position:absolute;left:0;top:0;font:700 12px/1.2 system-ui,Arial,sans-serif;color:#fff;background:#e91e63;padding:1px 4px;white-space:nowrap;';
      box.appendChild(label);
      c.appendChild(box);
    }
  }
  return { sx: window.scrollX, sy: window.scrollY };
})()`
}

const REMOVE_OVERLAY = `document.querySelectorAll('[data-visionaire-overlay]').forEach((n) => n.remove()); true`

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
  if (indexed.length === 0) throw new Error('mark discovery returned a malformed result')
  const metaJson = String(indexed[0].value!.value ?? '{}')
  const objectIds = indexed
    .slice(1)
    .map((p) => p.value!.objectId)
    .filter((id): id is string => typeof id === 'string')
  return { metaJson, objectIds }
}

function identityOf(m: { tag: string; classes: string[]; id?: string }): string {
  const id = m.id ? `#${m.id}` : ''
  return `<${m.tag}${id}${m.classes.map((c) => `.${c}`).join('')}>`
}

async function marksFromUids(ctx: ToolContext, uids: string[], skipped: string[]): Promise<Mark[]> {
  const marks: Mark[] = []
  for (const uid of [...new Set(uids)]) {
    const entry = ctx.uids.get(uid)
    if (!entry) {
      skipped.push(`${uid} (unknown uid — take a fresh page_snapshot)`)
      continue
    }
    try {
      const { object } = await ctx.cdp.send('DOM.resolveNode', {
        backendNodeId: entry.backendNodeId,
        objectGroup: OBJECT_GROUP,
      })
      if (!object.objectId) {
        skipped.push(`${uid} (not resolvable)`)
        continue
      }
      const res = await ctx.cdp.send('Runtime.callFunctionOn', {
        functionDeclaration: MEASURE_FN,
        objectId: object.objectId,
        returnByValue: true,
        objectGroup: OBJECT_GROUP,
      })
      const measured = res.exceptionDetails ? null : (res.result.value as MeasuredElement | null)
      if (!measured) {
        skipped.push(`${uid} (no longer an element in the DOM)`)
        continue
      }
      marks.push({ ...measured, uid, label: uid.replace(/^e/, '') })
    } catch {
      skipped.push(`${uid} (detached — take a fresh page_snapshot)`)
    }
  }
  return marks
}

async function defaultMarks(
  ctx: ToolContext,
  opts: { viewportOnly: boolean; region?: { x: number; y: number; width: number; height: number } },
): Promise<Mark[]> {
  const evaluated = await ctx.cdp.send('Runtime.evaluate', {
    expression: defaultMarksExpression({ max: DEFAULT_MAX_MARKS, ...opts }),
    objectGroup: OBJECT_GROUP,
  })
  if (evaluated.exceptionDetails) {
    throw new Error(`mark discovery failed in page: ${describeException(evaluated.exceptionDetails)}`)
  }
  if (!evaluated.result.objectId) throw new Error('mark discovery returned no result')
  const { metaJson, objectIds } = await unpackNodeArray(ctx, evaluated.result.objectId)
  const { items } = JSON.parse(metaJson) as { items: MeasuredElement[] }
  const marks: Mark[] = []
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
    marks.push({ ...item, uid, label: uid.replace(/^e/, '') })
  }
  return marks
}

export const annotatedScreenshotTool: ToolDef = {
  name: 'annotated_screenshot',
  description:
    'Screenshot with numbered marks burned in; mark numbers equal uid numbers (mark 17 = uid e17). Defaults to marking the top ~25 visible interactive/landmark elements; pass uids to mark specific elements.',
  inputSchema,
  handler: async (ctx, args) => {
    const a = argsSchema.parse(args)
    if (a.region && a.fullPage) throw new Error('region and fullPage are mutually exclusive')

    const skipped: string[] = []
    try {
      const marks =
        a.uids && a.uids.length > 0
          ? await marksFromUids(ctx, a.uids, skipped)
          : await defaultMarks(ctx, { viewportOnly: !a.fullPage, region: a.region })

      const overlay = await ctx.cdp.send('Runtime.evaluate', {
        expression: overlayExpression(marks.map((m) => ({ label: m.label, x: m.x, y: m.y, w: m.w, h: m.h }))),
        returnByValue: true,
      })
      if (overlay.exceptionDetails) {
        throw new Error(`overlay injection failed: ${describeException(overlay.exceptionDetails)}`)
      }
      const { sx, sy } = overlay.result.value as { sx: number; sy: number }

      const params: Protocol.Page.CaptureScreenshotRequest = { format: 'png' }
      if (a.region) {
        // CDP clip is document-relative when capturing beyond the viewport; region args are viewport coords.
        params.clip = {
          x: a.region.x + sx,
          y: a.region.y + sy,
          width: a.region.width,
          height: a.region.height,
          scale: 1,
        }
        params.captureBeyondViewport = true
      } else if (a.fullPage) {
        params.captureBeyondViewport = true
      }
      const shot = await ctx.cdp.send('Page.captureScreenshot', params)

      const scope = a.fullPage
        ? 'full page'
        : a.region
          ? `region ${a.region.width}x${a.region.height} @(${a.region.x},${a.region.y})`
          : 'viewport'
      const lines: string[] = [
        `annotated screenshot (${scope}) — ${marks.length} mark${marks.length === 1 ? '' : 's'}; mark number = uid digits (mark 17 = e17)`,
      ]
      if (marks.length > 0) {
        lines.push('marks:')
        for (const m of marks) {
          // fullPage image pixels are document coords; viewport/region legends stay in viewport coords.
          const lx = a.fullPage ? m.x + Math.round(sx) : m.x
          const ly = a.fullPage ? m.y + Math.round(sy) : m.y
          lines.push(`  ${m.label}=${m.uid} ${identityOf(m)}${m.text ? ` "${m.text}"` : ''} @(${lx},${ly})`)
        }
      } else {
        lines.push('no markable elements found — screenshot has no marks')
      }
      if (skipped.length > 0) lines.push(`skipped: ${skipped.join(', ')}`)

      return { text: lines.join('\n'), images: [{ data: shot.data, mimeType: 'image/png' }] }
    } finally {
      await ctx.cdp.send('Runtime.evaluate', { expression: REMOVE_OVERLAY, returnByValue: true }).catch(() => {})
      await ctx.cdp.send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => {})
    }
  },
}
