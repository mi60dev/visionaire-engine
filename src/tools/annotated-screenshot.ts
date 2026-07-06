/**
 * annotated_screenshot — SPEC §4 #11. Two modes:
 *
 *  1. Overview (default): marks are burned in by injecting one overlay container
 *     before Page.captureScreenshot and removing it in a finally block. Mark
 *     numbers ARE the uid numbers (mark 17 = uid e17).
 *  2. Element-scoped (clipTo): crop the shot to one element's border box (via
 *     DOM.getBoxModel), optionally padded and zoomed (scale) so a tiny element
 *     like an "x" can be seen enlarged. With annotate:false NO marks are drawn —
 *     a clean crop, so labels never cover the thing you want to look at.
 *
 * Empirical (headless Chrome, verified in a scratch probe): DOM.getBoxModel
 * returns VIEWPORT-relative quads, while Page.captureScreenshot's clip with
 * captureBeyondViewport:true is DOCUMENT-relative — so box coords must have the
 * page scroll offset added before they become a clip (same conversion the
 * region path already does). scale multiplies output pixel dimensions.
 */
import type { Protocol } from 'puppeteer-core'
import { z } from 'zod'
import type { TargetSpec, ToolContext, ToolDef } from '../types.js'
import { resolveTarget } from '../uid.js'

const OBJECT_GROUP = 'visionaire-annotated-screenshot'
const DEFAULT_MAX_MARKS = 25
const MIN_SCALE = 0.5
const MAX_SCALE = 4

const inputSchema = {
  uids: z
    .array(z.string())
    .optional()
    .describe('Uids to mark; default: top ~25 visible interactive/landmark elements'),
  region: z
    .object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() })
    .optional()
    .describe('Clip to this viewport rectangle (CSS px). Ignored when clipTo is given (clipTo wins).'),
  fullPage: z
    .boolean()
    .default(false)
    .describe('Capture the whole page height. Ignored when clipTo or region is given (they win).'),
  clipTo: z
    .object({
      uid: z.string().optional().describe('Element uid from a prior page_snapshot (e.g. "e8")'),
      selector: z.string().optional().describe('CSS selector — first match is used'),
      x: z.number().optional().describe('Viewport x coordinate (use with y)'),
      y: z.number().optional().describe('Viewport y coordinate (use with x)'),
    })
    .optional()
    .describe(
      "Crop the screenshot to this element's border box instead of the whole viewport " +
        '(target by uid | selector | x+y). Pairs with padding, scale, and annotate. ' +
        'Takes precedence over region and fullPage — pick ONE capture mode.',
    ),
  padding: z
    .number()
    .min(0)
    .default(0)
    .describe('clipTo only: extra pixels of margin around the cropped element on every side'),
  scale: z
    .number()
    .default(1)
    .describe(`clipTo only: zoom factor for the crop, clamped ${MIN_SCALE}..${MAX_SCALE} (2 = double size)`),
  annotate: z
    .boolean()
    .default(true)
    .describe('When false, burn in NO marks/labels — a clean crop so labels never cover the target'),
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

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/** Current page scroll offset — needed to convert viewport box coords to the document coords a clip expects. */
async function scrollOffset(ctx: ToolContext): Promise<{ sx: number; sy: number }> {
  const res = await ctx.cdp.send('Runtime.evaluate', {
    expression: '({ sx: window.scrollX, sy: window.scrollY })',
    returnByValue: true,
  })
  const v = (res.result.value ?? {}) as { sx?: number; sy?: number }
  return { sx: v.sx ?? 0, sy: v.sy ?? 0 }
}

interface ClipPlan {
  clip: Protocol.Page.Viewport
  /** Element identity for the caption, e.g. "<button#promo.btn>". */
  identity: string
  /** Document-coord crop rectangle, before scale, for the caption. */
  rect: { x: number; y: number; width: number; height: number }
}

/**
 * Resolve clipTo → the element's border box → a scale/padded document-coord clip.
 * getBoxModel throws for non-rendered nodes (display:none, zero-size); surface that
 * as an actionable error rather than a blank screenshot.
 */
async function planElementClip(
  ctx: ToolContext,
  target: TargetSpec,
  padding: number,
  scale: number,
): Promise<ClipPlan> {
  const node = await resolveTarget(ctx, target)

  let model: Protocol.DOM.BoxModel
  try {
    ;({ model } = await ctx.cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId }))
  } catch {
    throw new Error(
      `Cannot clip to ${node.uid}: it has no layout box (display:none, detached, or zero-size). ` +
        'Inspect it with inspect_element to see why it is not rendered.',
    )
  }

  // border quad: [tlx,tly, trx,try, brx,bry, blx,bly] — viewport coords; take its
  // axis-aligned bounding box (correct even under transforms).
  const b = model.border
  const xs = [b[0], b[2], b[4], b[6]]
  const ys = [b[1], b[3], b[5], b[7]]
  const vx = Math.min(...xs)
  const vy = Math.min(...ys)
  const w = Math.max(...xs) - vx
  const h = Math.max(...ys) - vy

  const { sx, sy } = await scrollOffset(ctx)
  // viewport → document, then pad on every side.
  const x = Math.max(0, vx + sx - padding)
  const y = Math.max(0, vy + sy - padding)
  const width = Math.max(1, w + padding * 2)
  const height = Math.max(1, h + padding * 2)

  // resolveTarget populates the registry with tag/classes/attrId for the node.
  const meta = ctx.uids.get(node.uid)
  const identity = identityOf({
    tag: meta?.tag ?? 'element',
    classes: meta?.classes ?? [],
    id: meta?.attrId,
  })

  return {
    clip: { x, y, width, height, scale },
    identity,
    rect: { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) },
  }
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

function targetFromClipTo(clipTo: {
  uid?: string
  selector?: string
  x?: number
  y?: number
}): TargetSpec {
  return { uid: clipTo.uid, selector: clipTo.selector, x: clipTo.x, y: clipTo.y }
}

export const annotatedScreenshotTool: ToolDef = {
  name: 'annotated_screenshot',
  description:
    'Screenshot in one of two modes. Overview (default): numbered marks burned in, ' +
    'mark numbers equal uid numbers (mark 17 = uid e17), over the top ~25 visible ' +
    'interactive/landmark elements (or the uids you pass). Element-scoped (clipTo): ' +
    'crop to one element\'s box (uid | selector | x+y) with optional padding and scale ' +
    '(zoom a tiny element like an "x"); set annotate:false for a clean crop with no ' +
    'labels covering the target.',
  inputSchema,
  handler: async (ctx, args) => {
    const a = argsSchema.parse(args)
    // Capture-mode precedence instead of hard errors: an LLM combining these has an
    // obvious intent (the most specific mode). Resolve it, do the work, and say so
    // in the caption — one successful call beats an error round-trip.
    const precedenceNotes: string[] = []
    if (a.clipTo && (a.region || a.fullPage)) {
      const ignored = [a.region ? 'region' : '', a.fullPage ? 'fullPage' : ''].filter(Boolean).join(' and ')
      precedenceNotes.push(`note: ${ignored} ignored — clipTo is the capture mode and takes precedence`)
      a.region = undefined
      a.fullPage = false
    } else if (a.region && a.fullPage) {
      precedenceNotes.push('note: fullPage ignored — region is more specific and takes precedence')
      a.fullPage = false
    }

    const scale = clamp(a.scale, MIN_SCALE, MAX_SCALE)
    // Resolve the element crop up front so a bad target fails before we touch the DOM overlay.
    const plan = a.clipTo ? await planElementClip(ctx, targetFromClipTo(a.clipTo), a.padding, scale) : undefined

    const skipped: string[] = []
    // annotate:false → skip mark discovery and overlay injection entirely (a clean crop).
    // clipTo marks would need document-coord placement inside the crop; keep the annotated
    // path to the whole-viewport/region/fullPage overview it was designed for.
    const drawMarks = a.annotate && !a.clipTo
    try {
      const marks = drawMarks
        ? a.uids && a.uids.length > 0
          ? await marksFromUids(ctx, a.uids, skipped)
          : await defaultMarks(ctx, { viewportOnly: !a.fullPage, region: a.region })
        : []

      let sx = 0
      let sy = 0
      if (drawMarks) {
        const overlay = await ctx.cdp.send('Runtime.evaluate', {
          expression: overlayExpression(marks.map((m) => ({ label: m.label, x: m.x, y: m.y, w: m.w, h: m.h }))),
          returnByValue: true,
        })
        if (overlay.exceptionDetails) {
          throw new Error(`overlay injection failed: ${describeException(overlay.exceptionDetails)}`)
        }
        ;({ sx, sy } = overlay.result.value as { sx: number; sy: number })
      } else if (a.region) {
        // region without an overlay still needs the scroll offset to build a document-coord clip.
        ;({ sx, sy } = await scrollOffset(ctx))
      }

      const params: Protocol.Page.CaptureScreenshotRequest = { format: 'png' }
      if (plan) {
        params.clip = plan.clip
        params.captureBeyondViewport = true
      } else if (a.region) {
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

      if (plan) {
        const r = plan.rect
        const lines = [
          `element screenshot ${plan.identity} — crop ${r.width}x${r.height} @(${r.x},${r.y}) doc px` +
            (scale !== 1 ? ` @${scale}x` : '') +
            (a.padding > 0 ? ` (+${a.padding}px padding)` : '') +
            (a.annotate ? '' : ' — clean crop, no marks'),
          ...precedenceNotes,
        ]
        return { text: lines.join('\n'), images: [{ data: shot.data, mimeType: 'image/png' }] }
      }

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
      } else if (a.annotate) {
        lines.push('no markable elements found — screenshot has no marks')
      }
      if (skipped.length > 0) lines.push(`skipped: ${skipped.join(', ')}`)
      lines.push(...precedenceNotes)

      return { text: lines.join('\n'), images: [{ data: shot.data, mimeType: 'image/png' }] }
    } finally {
      // Mark discovery allocates in OBJECT_GROUP and (on the annotated path) injects the
      // overlay — always tear both down when we drew marks, even if capture threw partway.
      // A clean crop (clipTo / annotate:false) never touches the page, so nothing to undo.
      if (drawMarks) {
        await ctx.cdp.send('Runtime.evaluate', { expression: REMOVE_OVERLAY, returnByValue: true }).catch(() => {})
        await ctx.cdp.send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => {})
      }
    }
  },
}
