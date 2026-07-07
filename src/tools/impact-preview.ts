/**
 * impact_preview — blast-radius report BEFORE editing a shared selector
 * (v-next SPEC §3D). Answers two questions deterministically:
 *   1. WHO ELSE matches this selector on the current page (grouped by visual
 *      role / region / tag, with uids)?
 *   2. WHAT WOULD ACTUALLY CHANGE if the proposed declarations landed —
 *      dry-run via a sandboxed injected <style data-visionaire-impact> that is
 *      always removed, diffing computed values before/after a forced recompute.
 *
 * Scope honesty: everything here is the CURRENT page at the CURRENT viewport;
 * other routes/viewports/states are invisible to a live-page tool.
 */
import fs from 'node:fs'
import { z } from 'zod'
import type { ToolContext, ToolDef, ToolResult } from '../types.js'
import { sanitizePageText } from '../types.js'
import { groupImpact, regionOf, type ImpactGroup, type ImpactItem } from '../engine/impact.js'
import { artifactPath } from '../store/artifacts.js'
import { annotatedScreenshotTool } from './annotated-screenshot.js'

const OBJECT_GROUP = 'visionaire-impact-preview'
/** Per-element facts and the dry-run cover at most this many matches (match_count stays exact). */
const MAX_ELEMENTS = 40
/** Spec cap: at most this many {uid, prop, before, after} rows per response page. */
const MAX_CHANGED_PER_PAGE = 20
/** Spec cap: at most this many uids listed per group in the summary envelope. */
const MAX_UIDS_PER_GROUP = 50
const MAX_DECLARATIONS = 20
/** Keep the envelope comfortably under the ~15KB transport floor (v-next SPEC §7). */
const MAX_RESPONSE_BYTES = Math.max(4_000, Number(process.env['VISIONAIRE_MAX_RESPONSE_KB']) * 1024 || 15_000)

const SCOPE_HONESTY =
  'impact is computed for the currently open page at the current viewport only — other routes/viewports/states ' +
  'are not visible here (use responsive_sweep for other viewports)'

const inputSchema = {
  selector: z
    .string()
    .min(1)
    .describe('The shared CSS selector you are about to edit — ALL current matches are counted and grouped'),
  group_by: z
    .enum(['visual_role', 'region', 'tag'])
    .default('visual_role')
    .describe(
      "How to group matches: 'visual_role' = tag + up-to-2 classes + screen region + ARIA role, " +
        "'region' = top/middle/bottom of the document, 'tag' = element tag name",
    ),
  proposed_change: z
    .object({
      declarations: z
        .record(z.string())
        .describe('CSS property → value pairs to dry-run, e.g. {"padding": "20px", "color": "red"}'),
    })
    .optional()
    .describe(
      'Dry-run: sandbox-inject `selector { declarations }`, force a recompute, diff computed values per element, ' +
        'then remove the injected style — predicts which matches would ACTUALLY change (specificity/!important losers stay unaffected)',
    ),
  detail: z
    .enum(['summary', 'full'])
    .default('summary')
    .describe("'full' additionally saves an annotated screenshot of the first matches to the artifacts dir"),
  page: z
    .object({
      offset: z.number().int().min(0).default(0).describe('Skip this many entries'),
      limit: z.number().int().min(1).max(100).default(20).describe('Max entries returned in this call'),
    })
    .optional()
    .describe('Paginates dry_run.changed when proposed_change is given, otherwise the groups list'),
}

const argsSchema = z.object(inputSchema)

// ───────────────────────── In-page programs ─────────────────────────

/**
 * ONE pass over the matches: JSON facts first, then the element handles
 * (returnByValue:false + Runtime.getProperties unpacks both) so uids can be
 * assigned to the exact elements the facts describe.
 */
const GATHER_FN = `function (selector, max) {
  var els = Array.prototype.slice.call(document.querySelectorAll(selector), 0, max);
  var sx = window.scrollX, sy = window.scrollY;
  var meta = els.map(function (el) {
    var r = el.getBoundingClientRect();
    var id = el.id ? '#' + el.id : '';
    var cls = Array.prototype.slice.call(el.classList, 0, 2).map(function (c) { return '.' + c; }).join('');
    var o = {
      tag: el.tagName.toLowerCase(),
      classes: Array.prototype.slice.call(el.classList, 0, 8),
      identity: '<' + el.tagName.toLowerCase() + id + cls + '>',
      rect: (r.width > 0 || r.height > 0 || el.getClientRects().length > 0)
        ? { x: r.left + sx, y: r.top + sy, width: r.width, height: r.height }
        : null,
    };
    if (el.id) o.attrId = el.id;
    var role = el.getAttribute('role');
    if (role) o.role = role;
    if (el.tagName === 'INPUT') o.inputType = (el.getAttribute('type') || 'text').toLowerCase();
    return o;
  });
  var body = document.body;
  var pageHeight = Math.max(
    document.documentElement.scrollHeight,
    body ? body.scrollHeight : 0
  );
  return [JSON.stringify({ meta: meta, pageHeight: pageHeight })].concat(els);
}`

/**
 * Dry-run in one round trip: read the declared properties' computed values,
 * inject the sandboxed style, force a recompute (offsetHeight read), re-read,
 * and ALWAYS remove the style in the in-page finally. querySelectorAll is
 * document-ordered, so indexes line up with the GATHER_FN pass.
 */
const DRY_RUN_FN = `function (selector, props, cssText, max) {
  var els = Array.prototype.slice.call(document.querySelectorAll(selector), 0, max);
  var read = function () {
    return els.map(function (el) {
      var cs = getComputedStyle(el);
      return props.map(function (p) { return cs.getPropertyValue(p); });
    });
  };
  var before = read();
  var style = document.createElement('style');
  style.setAttribute('data-visionaire-impact', '');
  style.textContent = cssText;
  var after;
  try {
    (document.head || document.documentElement).appendChild(style);
    void document.documentElement.offsetHeight;
    after = read();
  } finally {
    style.remove();
    void document.documentElement.offsetHeight;
  }
  return { before: before, after: after };
}`

/** Belt-and-braces cleanup — the in-page finally already removes the style tag. */
const REMOVE_STYLE_EXPR = `(function () {
  var tags = document.querySelectorAll('style[data-visionaire-impact]');
  for (var i = 0; i < tags.length; i++) tags[i].remove();
  return true;
})()`

// ───────────────────────── Envelope shapes ─────────────────────────

interface RenderedGroup extends ImpactGroup {
  uids_truncated?: boolean
}

interface ChangedRow {
  uid: string
  prop: string
  before: string
  after: string
}

interface DryRunReport {
  would_change_count: number
  unaffected_count: number
  changed: ChangedRow[]
  method: string
  notes?: string[]
}

interface Envelope {
  summary: string
  match_count: number
  groups: RenderedGroup[]
  dry_run?: DryRunReport
  artifacts?: Array<{ kind: string; path: string }>
  notes?: string[]
  truncated: boolean
  next_offset?: number
}

interface GatherMeta {
  tag: string
  classes: string[]
  identity: string
  rect: { x: number; y: number; width: number; height: number } | null
  attrId?: string
  role?: string
  inputType?: string
}

// ───────────────────────── Helpers ─────────────────────────

async function trueMatchCount(ctx: ToolContext, selector: string): Promise<number> {
  const res = await ctx.cdp.send('Runtime.evaluate', {
    expression: `document.querySelectorAll(${JSON.stringify(selector)}).length`,
    returnByValue: true,
  })
  if (res.exceptionDetails) throw new Error(`Invalid CSS selector: ${selector}`)
  return typeof res.result.value === 'number' ? res.result.value : 0
}

/** One in-page pass → sanitized ImpactItems (uids assigned to the live elements) + pageHeight. */
async function gatherFacts(
  ctx: ToolContext,
  selector: string,
): Promise<{ items: ImpactItem[]; pageHeight: number }> {
  const evaluated = await ctx.cdp.send('Runtime.evaluate', {
    expression: `(${GATHER_FN})(${JSON.stringify(selector)}, ${MAX_ELEMENTS})`,
    returnByValue: false,
    objectGroup: OBJECT_GROUP,
  })
  if (evaluated.exceptionDetails || !evaluated.result.objectId) {
    throw new Error(`Invalid CSS selector: ${selector}`)
  }
  const props = await ctx.cdp.send('Runtime.getProperties', {
    objectId: evaluated.result.objectId,
    ownProperties: true,
  })
  const indexed = props.result
    .filter((p) => /^\d+$/.test(p.name) && p.value !== undefined)
    .sort((a, b) => Number(a.name) - Number(b.name))
  const parsed = JSON.parse(String(indexed[0]?.value?.value ?? '{"meta":[],"pageHeight":0}')) as {
    meta: GatherMeta[]
    pageHeight: number
  }

  const items: ImpactItem[] = []
  for (let i = 0; i < parsed.meta.length; i++) {
    const m = parsed.meta[i]!
    const objectId = indexed[i + 1]?.value?.objectId
    let uid = `#${i + 1}`
    if (typeof objectId === 'string') {
      try {
        const described = await ctx.cdp.send('DOM.describeNode', { objectId })
        uid = ctx.uids.assign(described.node.backendNodeId, {
          tag: m.tag,
          classes: m.classes,
          attrId: m.attrId,
        })
      } catch {
        // identity string still names the element
      }
    }
    const item: ImpactItem = {
      uid,
      tag: sanitizePageText(m.tag, 40),
      classes: m.classes.map((c) => sanitizePageText(c, 40)),
      identity: sanitizePageText(m.identity, 60),
    }
    if (m.attrId !== undefined) item.attrId = sanitizePageText(m.attrId, 40)
    if (m.role !== undefined) item.role = sanitizePageText(m.role, 40)
    if (m.inputType !== undefined) item.inputType = sanitizePageText(m.inputType, 20)
    if (m.rect) item.rect = m.rect
    items.push(item)
  }
  return { items, pageHeight: parsed.pageHeight }
}

function validateDeclarations(declarations: Record<string, string>): Array<[string, string]> {
  const entries = Object.entries(declarations)
  if (entries.length === 0) {
    throw new Error('proposed_change.declarations is empty — provide at least one css-property: value pair')
  }
  if (entries.length > MAX_DECLARATIONS) {
    throw new Error(`proposed_change.declarations has ${entries.length} entries — dry-run at most ${MAX_DECLARATIONS} per call`)
  }
  for (const [prop, value] of entries) {
    if (!/^-?[a-zA-Z][a-zA-Z0-9-]*$/.test(prop)) {
      throw new Error(`invalid css property name "${prop}" — use kebab-case property names like "padding" or "background-color"`)
    }
    if (/[{}]/.test(value)) {
      throw new Error(`declaration value for "${prop}" contains '{' or '}' — pass a plain CSS value, one property per entry`)
    }
  }
  return entries
}

async function runDryRun(
  ctx: ToolContext,
  selector: string,
  entries: Array<[string, string]>,
  items: ImpactItem[],
): Promise<{ allChanged: ChangedRow[]; wouldChange: number; unaffected: number; notes: string[] }> {
  const props = entries.map(([p]) => p)
  const cssText = `${selector} { ${entries.map(([p, v]) => `${p}: ${v}`).join('; ')} }`
  const res = await ctx.cdp.send('Runtime.evaluate', {
    expression: `(${DRY_RUN_FN})(${JSON.stringify(selector)}, ${JSON.stringify(props)}, ${JSON.stringify(cssText)}, ${MAX_ELEMENTS})`,
    returnByValue: true,
  })
  if (res.exceptionDetails) {
    throw new Error(
      `dry-run failed in page: ${res.exceptionDetails.exception?.description?.split('\n')[0] ?? res.exceptionDetails.text} — ` +
        'check the declaration values are valid CSS',
    )
  }
  const { before, after } = res.result.value as { before: string[][]; after: string[][] }

  const allChanged: ChangedRow[] = []
  const changedElements = new Set<number>()
  const changedPerProp = new Map<string, number>(props.map((p) => [p, 0]))
  const n = Math.min(items.length, before.length, after.length)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < props.length; j++) {
      const b = before[i]?.[j] ?? ''
      const a = after[i]?.[j] ?? ''
      if (b !== a) {
        changedElements.add(i)
        changedPerProp.set(props[j]!, (changedPerProp.get(props[j]!) ?? 0) + 1)
        allChanged.push({
          uid: items[i]!.uid,
          prop: props[j]!,
          before: sanitizePageText(b, 60),
          after: sanitizePageText(a, 60),
        })
      }
    }
  }

  const notes: string[] = []
  for (const [prop, value] of entries) {
    if ((changedPerProp.get(prop) ?? 0) === 0) {
      notes.push(
        `DRY_RUN_UNSUPPORTED_DECLARATION: '${prop}: ${value}' changed the computed value of 0 matched elements — ` +
          'a more specific or !important rule may beat the injected rule, a media query may gate it, ' +
          'or every element already computes to that value',
      )
    }
  }
  return { allChanged, wouldChange: changedElements.size, unaffected: n - changedElements.size, notes }
}

function renderGroups(groups: ImpactGroup[], uidCap: number): RenderedGroup[] {
  return groups.map((g) => {
    if (g.uids.length <= uidCap) return { ...g }
    return { ...g, uids: g.uids.slice(0, uidCap), uids_truncated: true }
  })
}

// ───────────────────────── The tool ─────────────────────────

export const impactPreviewTool: ToolDef = {
  name: 'impact_preview',
  description:
    'Blast-radius report BEFORE editing a shared CSS selector: how many elements match on the current page, ' +
    'grouped by visual role / screen region / tag (with uids), plus an optional sandboxed dry-run of proposed ' +
    'declarations that predicts exactly which elements would change and which are protected by more specific rules. ' +
    'Call this before widening or editing any selector that might style more than your target.',
  inputSchema,
  async handler(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const a = argsSchema.parse(args)
    const selector = a.selector

    const matchCount = await trueMatchCount(ctx, selector)
    if (matchCount === 0) {
      const envelope: Envelope = {
        summary:
          `'${selector}' matches 0 elements on the current page — nothing here would be affected ` +
          '(check the selector spelling or navigate to a page that uses it)',
        match_count: 0,
        groups: [],
        truncated: false,
      }
      return { text: JSON.stringify(envelope, null, 1) }
    }

    const notes: string[] = []
    const artifacts: Array<{ kind: string; path: string }> = []
    try {
      const { items, pageHeight } = await gatherFacts(ctx, selector)
      if (matchCount > items.length) {
        notes.push(
          `facts gathered for the first ${items.length} of ${matchCount} matches — grouping and dry-run cover those ${items.length}`,
        )
      }

      const groups = groupImpact(items, a.group_by, pageHeight)
      const regionCount = new Set(items.map((i) => regionOf(i.rect, pageHeight))).size

      // Summary sentence: "'.nav-item' matches 23 elements across 4 visual roles, 3 screen regions".
      const groupNoun = a.group_by === 'visual_role' ? 'visual role' : a.group_by === 'region' ? 'screen region' : 'tag'
      const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`
      let summary = `'${selector}' matches ${plural(matchCount, 'element')} across ${plural(groups.length, groupNoun)}`
      if (a.group_by !== 'region') summary += `, ${plural(regionCount, 'screen region')}`
      if (matchCount > 10) summary += `. ${SCOPE_HONESTY}`

      // Dry-run the proposed declarations against the live render.
      let dryRun: DryRunReport | undefined
      let allChanged: ChangedRow[] = []
      if (a.proposed_change) {
        const entries = validateDeclarations(a.proposed_change.declarations)
        const run = await runDryRun(ctx, selector, entries, items)
        allChanged = run.allChanged
        dryRun = {
          would_change_count: run.wouldChange,
          unaffected_count: run.unaffected,
          changed: [],
          method: 'sandboxed inject_css + recompute',
        }
        if (run.notes.length > 0) dryRun.notes = run.notes
      }

      // detail 'full': annotated screenshot of the first matches, saved as an artifact path.
      if (a.detail === 'full') {
        try {
          const shot = await annotatedScreenshotTool.handler(ctx, { uids: items.slice(0, 12).map((i) => i.uid) })
          const img = shot.images?.[0]
          if (img) {
            const p = artifactPath('impact', 'png')
            fs.writeFileSync(p, Buffer.from(img.data, 'base64'))
            artifacts.push({ kind: 'annotated_screenshot', path: p })
          }
        } catch (e) {
          notes.push(`annotated screenshot skipped: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      // Pagination: page applies to dry_run.changed when a dry-run ran, else to groups.
      const offset = a.page?.offset ?? 0
      let limit = a.page?.limit ?? 20

      const build = (lim: number, uidCap: number): Envelope => {
        const env: Envelope = { summary, match_count: matchCount, groups: [], truncated: false }
        let total: number
        let shown: number
        if (dryRun) {
          env.groups = renderGroups(groups, uidCap)
          const pageRows = allChanged.slice(offset, offset + Math.min(lim, MAX_CHANGED_PER_PAGE))
          env.dry_run = { ...dryRun, changed: pageRows }
          total = allChanged.length
          shown = pageRows.length
        } else {
          const pageGroups = groups.slice(offset, offset + lim)
          env.groups = renderGroups(pageGroups, uidCap)
          total = groups.length
          shown = pageGroups.length
        }
        if (artifacts.length > 0) env.artifacts = artifacts
        if (notes.length > 0) env.notes = notes
        if (env.groups.some((g) => g.uids_truncated)) env.truncated = true
        if (offset + shown < total) {
          env.truncated = true
          env.next_offset = offset + shown
        }
        return env
      }

      // Byte-budget backstop: halve the page, then squeeze per-group uid lists.
      let uidCap = MAX_UIDS_PER_GROUP
      let envelope = build(limit, uidCap)
      while (JSON.stringify(envelope, null, 1).length > MAX_RESPONSE_BYTES && (limit > 1 || uidCap > 5)) {
        if (limit > 1) limit = Math.max(1, Math.floor(limit / 2))
        else uidCap = Math.max(5, Math.floor(uidCap / 2))
        envelope = build(limit, uidCap)
      }

      return { text: JSON.stringify(envelope, null, 1) }
    } finally {
      if (a.proposed_change) {
        await ctx.cdp.send('Runtime.evaluate', { expression: REMOVE_STYLE_EXPR, returnByValue: true }).catch(() => {})
      }
      await ctx.cdp.send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => {})
    }
  },
}
