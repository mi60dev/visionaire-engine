/**
 * explain_styles — the wedge (SPEC §4, §8.3): per-property cascade verdicts with
 * loss reasons, each declaration joined to its editable origin (file:line / WP entity).
 */
import { z } from 'zod'
import type { Protocol } from 'puppeteer-core'
import type {
  AttributedVerdict,
  DeclarationInfo,
  ElementSummary,
  PropertyVerdict,
  Specificity,
  ToolContext,
  ToolDef,
  ToolResult,
  VisibilityReport,
  WhyDossierInput,
} from '../types.js'
import { estimateTokens } from '../types.js'
import { buildScopeNotes, collectScopeData } from '../engine/scope.js'
import { pairAttributes, resolveTarget } from '../uid.js'
import { computeCascade } from '../engine/cascade.js'
import { findInactiveDeclarations } from '../engine/inactive.js'
import { assessVisibility } from '../engine/visibility.js'
import { resolveAuthoredPosition } from '../attribution/sourcemaps.js'
import { renderWhyDossier, type RenderableDeclaration } from '../format/dossier.js'

/** Per-element dossier budget — SPEC §5 upper bound (300–800 tokens). */
const DOSSIER_BUDGET_TOKENS = 800

/** Shorthand → longhands, for the `property:` filter family (SPEC §4, §6.1 list). */
const SHORTHAND_FAMILY: Record<string, string[]> = {
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  border: [
    'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
    'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
    'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  ],
  'border-width': ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
  'border-style': ['border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style'],
  'border-color': ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
  'border-top': ['border-top-width', 'border-top-style', 'border-top-color'],
  'border-right': ['border-right-width', 'border-right-style', 'border-right-color'],
  'border-bottom': ['border-bottom-width', 'border-bottom-style', 'border-bottom-color'],
  'border-left': ['border-left-width', 'border-left-style', 'border-left-color'],
  'border-radius': [
    'border-top-left-radius', 'border-top-right-radius',
    'border-bottom-right-radius', 'border-bottom-left-radius',
  ],
  background: [
    'background-color', 'background-image', 'background-position', 'background-size',
    'background-repeat', 'background-attachment', 'background-origin', 'background-clip',
  ],
  font: ['font-family', 'font-size', 'font-style', 'font-variant', 'font-weight', 'font-stretch', 'line-height'],
  flex: ['flex-grow', 'flex-shrink', 'flex-basis'],
  'flex-flow': ['flex-direction', 'flex-wrap'],
  gap: ['row-gap', 'column-gap'],
  inset: ['top', 'right', 'bottom', 'left'],
  overflow: ['overflow-x', 'overflow-y'],
  'place-content': ['align-content', 'justify-content'],
  'place-items': ['align-items', 'justify-items'],
  'place-self': ['align-self', 'justify-self'],
  'grid-area': ['grid-row-start', 'grid-column-start', 'grid-row-end', 'grid-column-end'],
  'grid-row': ['grid-row-start', 'grid-row-end'],
  'grid-column': ['grid-column-start', 'grid-column-end'],
  'text-decoration': [
    'text-decoration-line', 'text-decoration-style', 'text-decoration-color', 'text-decoration-thickness',
  ],
  outline: ['outline-width', 'outline-style', 'outline-color'],
  'list-style': ['list-style-type', 'list-style-position', 'list-style-image'],
  columns: ['column-width', 'column-count'],
  transition: ['transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay'],
  animation: [
    'animation-name', 'animation-duration', 'animation-timing-function', 'animation-delay',
    'animation-iteration-count', 'animation-direction', 'animation-fill-mode', 'animation-play-state',
  ],
}

interface ExplainArgs {
  uid?: string
  selector?: string
  x?: number
  y?: number
  property?: string
}

export const explainStylesTool: ToolDef = {
  name: 'explain_styles',
  description:
    'Explain WHY an element looks the way it does: per-property cascade winner/loser verdicts ' +
    '(specificity, !important, layers, source order), each mapped to its editable origin — ' +
    'file:line, WordPress entity, or builder control. Includes inactive-declaration warnings. ' +
    'Target by uid (from page_snapshot), CSS selector, or x+y. ' +
    'Pass property to focus on one property and its shorthand family.',
  inputSchema: {
    uid: z.string().optional().describe('Element uid from a prior page_snapshot / find_elements'),
    selector: z.string().optional().describe('CSS selector (first match) — alternative to uid'),
    x: z.number().optional().describe('Viewport x coordinate — use together with y'),
    y: z.number().optional().describe('Viewport y coordinate — use together with x'),
    property: z
      .string()
      .optional()
      .describe('CSS property (longhand or shorthand) to explain; omit for all competing/authored properties'),
  },
  handler: explainStyles,
}

async function explainStyles(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const a = args as ExplainArgs
  const node = await resolveTarget(ctx, a)

  const matched = await ctx.cdp.send('CSS.getMatchedStylesForNode', { nodeId: node.nodeId })
  const computedRes = await ctx.cdp.send('CSS.getComputedStyleForNode', { nodeId: node.nodeId })
  const computed = new Map(computedRes.computedStyle.map((p) => [p.name, p.value]))

  const verdicts = computeCascade(matched, computed)

  const filter = a.property?.trim().toLowerCase()
  const family = filter ? new Set([filter, ...(SHORTHAND_FAMILY[filter] ?? [])]) : undefined

  let selected: PropertyVerdict[]
  if (filter && family) {
    selected = verdicts.filter(
      (v) =>
        family.has(v.property) ||
        v.winner?.fromShorthand === filter ||
        v.losers.some((l) => l.decl.fromShorthand === filter),
    )
    if (!selected.length) {
      // Renderer emits "no authored declaration" for a winner-less verdict.
      selected = [{ property: filter, losers: [], computedValue: computed.get(filter) }]
    }
  } else {
    // SPEC §4: every property with ≥2 competing declarations or an authored (non-UA) winner.
    selected = verdicts.filter((v) => v.losers.length >= 1 || (v.winner && v.winner.originType !== 'user-agent'))
    const count = (v: PropertyVerdict): number => (v.winner ? 1 : 0) + v.losers.length
    const authored = (v: PropertyVerdict): number => (v.winner && v.winner.originType !== 'user-agent' ? 1 : 0)
    selected.sort(
      (x, y) => count(y) - count(x) || authored(y) - authored(x) || x.property.localeCompare(y.property),
    )
  }

  // ── attribution join (SPEC §7) ──
  const inheritedMetaCache = new Map<number, { tag?: string; classes?: string[]; attrId?: string }>()

  const describeBackend = async (backendNodeId: number) => {
    const cached = inheritedMetaCache.get(backendNodeId)
    if (cached) return cached
    const d = await ctx.cdp.send('DOM.describeNode', { backendNodeId })
    const attrs = pairAttributes(d.node.attributes)
    const meta = {
      tag: d.node.nodeName.toLowerCase(),
      classes: (attrs.get('class') ?? '').split(/\s+/).filter(Boolean),
      attrId: attrs.get('id'),
    }
    inheritedMetaCache.set(backendNodeId, meta)
    ctx.uids.assign(backendNodeId, meta)
    return meta
  }

  // Owner-node id attributes carry WP handles (wp-custom-css, global-styles-inline-css, {handle}-css);
  // without them the resolver misses db-entity classifications and degrades to generic inline/file labels.
  await ctx.sheets.ensureOwnerIds()

  const attributeDecl = async (decl: DeclarationInfo): Promise<RenderableDeclaration> => {
    const out: RenderableDeclaration = { ...decl }
    if (decl.styleSheetId) {
      const sheet = ctx.sheets.get(decl.styleSheetId)
      if (sheet) {
        if (sheet.sourceURL) out.sheetSourceURL = sheet.sourceURL
        const origin = ctx.sheets.classify(sheet, decl.selector)
        out.origin = origin
        if (origin.granularity === 'line' && sheet.sourceMapURL && decl.range) {
          try {
            // CDP SourceRange is 0-based; sourcemaps module owns trace-mapping base conversion.
            out.authored = await resolveAuthoredPosition(sheet, decl.range.startLine, decl.range.startColumn)
          } catch {
            out.authored = undefined
          }
          if (!out.authored) {
            // SPEC §7.2: source-map failure degrades line → file, with an explicit note.
            out.origin = {
              ...origin,
              granularity: 'file',
              editSurface: origin.editSurface
                ? `${origin.editSurface} (source map unresolved)`
                : 'source map unresolved',
            }
          }
        }
      }
    }
    if (decl.inheritedFromBackendNodeId !== undefined) {
      const bid = decl.inheritedFromBackendNodeId
      const uid = ctx.uids.byBackendId(bid) ?? ctx.uids.assign(bid)
      try {
        out.inheritedFrom = { uid, ...(await describeBackend(bid)) }
      } catch {
        out.inheritedFrom = { uid }
      }
    }
    return out
  }

  const attributed: AttributedVerdict[] = []
  for (const v of selected) {
    const losers: AttributedVerdict['losers'] = []
    for (const l of v.losers) losers.push({ decl: await attributeDecl(l.decl), reason: l.reason })
    attributed.push({
      property: v.property,
      winner: v.winner ? await attributeDecl(v.winner) : undefined,
      losers,
      computedValue: v.computedValue,
      uncertain: v.uncertain,
    })
  }

  // ── element summary (uid registry, DOM.describeNode fallback) ──
  const entry = ctx.uids.get(node.uid)
  const element: ElementSummary = {
    uid: node.uid,
    tag: entry?.tag ?? '',
    classes: entry?.classes ?? [],
    attrId: entry?.attrId,
    text: entry?.textPreview,
  }
  if (!element.tag) {
    try {
      const d = await ctx.cdp.send('DOM.describeNode', { nodeId: node.nodeId })
      const attrs = pairAttributes(d.node.attributes)
      element.tag = d.node.nodeName.toLowerCase()
      element.classes = (attrs.get('class') ?? '').split(/\s+/).filter(Boolean)
      element.attrId = attrs.get('id')
      ctx.uids.assign(node.backendNodeId, { tag: element.tag, classes: element.classes, attrId: element.attrId })
    } catch {
      element.tag = 'node'
    }
  }

  // ── visibility: included only when the element is NOT visible ──
  let visibility: VisibilityReport | undefined
  try {
    const report = await assessVisibility(ctx, node)
    if (!report.visible) visibility = report
  } catch {
    // visibility engine failure never blocks the verdicts
  }

  // ── inactive declarations over authored, non-inherited winners ──
  const winnerDecls = attributed
    .map((v) => v.winner)
    .filter(
      (d): d is RenderableDeclaration =>
        !!d &&
        d.originType !== 'user-agent' &&
        d.originType !== 'inherited' &&
        d.originType !== 'inherited-inline',
    )
  let parentDisplay: string | undefined
  try {
    parentDisplay = await getParentDisplay(ctx, node.nodeId, matched.parentLayoutNodeId)
  } catch {
    parentDisplay = undefined
  }
  const inactive = winnerDecls.length ? findInactiveDeclarations(winnerDecls, computed, parentDisplay) : []

  // ── blast radius + scoped-fix suggestion (the "change THE button, not all buttons" section) ──
  let scopeNotes: string[] = []
  try {
    const winnerSelectors: string[] = []
    const winnerSpecs = new Map<string, Specificity | undefined>()
    for (const v of attributed) {
      const w = v.winner
      if (!w || w.originType !== 'matched' || !w.selector) continue
      if (!winnerSelectors.includes(w.selector)) {
        winnerSelectors.push(w.selector)
        winnerSpecs.set(w.selector, w.specificity)
      }
      if (winnerSelectors.length >= 4) break
    }
    const data = await collectScopeData(ctx, node.backendNodeId, winnerSelectors)
    if (data) scopeNotes = buildScopeNotes(data, winnerSpecs)
  } catch {
    scopeNotes = [] // additive only
  }

  // ── notes: @media/@layer context, verdict-uncertain, keyframes presence ──
  const keyframesNote = buildKeyframesNote(matched.cssKeyframesRules, filter, family)
  const notesFor = (included: AttributedVerdict[]): string[] => {
    const notes: string[] = []
    const byMedia = new Map<string, string[]>()
    const byLayer = new Map<string, string[]>()
    for (const v of included) {
      if (v.winner?.media) {
        const key = v.winner.media
        byMedia.set(key, [...(byMedia.get(key) ?? []), v.property])
      }
      if (v.winner?.layer) {
        byLayer.set(v.winner.layer, [...(byLayer.get(v.winner.layer) ?? []), v.property])
      }
      if (v.uncertain) {
        notes.push(
          `verdict-uncertain (computed disagrees) for ${v.property}: predicted '${v.winner?.value ?? '?'}', computed '${v.computedValue ?? '?'}'`,
        )
      }
    }
    for (const [media, props] of byMedia) {
      const cond = media.startsWith('@media') ? media : `@media ${media}`
      notes.push(
        props.length === 1
          ? `winner for ${props[0]} sits inside ${cond}`
          : `winners for ${props.join(', ')} sit inside ${cond}`,
      )
    }
    for (const [layer, props] of byLayer) {
      notes.push(
        props.length === 1
          ? `winner for ${props[0]} sits inside @layer ${layer}`
          : `winners for ${props.join(', ')} sit inside @layer ${layer}`,
      )
    }
    if (keyframesNote) notes.push(keyframesNote)
    notes.push(...scopeNotes)
    return notes
  }

  // ── budget-ordered truncation (SPEC §8.3); property-filtered calls are never truncated ──
  let included: AttributedVerdict[]
  let truncated = 0
  if (filter) {
    included = attributed
  } else {
    included = []
    for (const v of attributed) {
      const trial = [...included, v]
      const text = renderWhyDossier({
        element,
        visibility,
        verdicts: trial,
        inactive,
        notes: notesFor(trial),
      })
      if (included.length > 0 && estimateTokens(text) > DOSSIER_BUDGET_TOKENS) break
      included = trial
    }
    truncated = attributed.length - included.length
  }

  const input: WhyDossierInput = {
    element,
    visibility,
    verdicts: included,
    inactive,
    notes: notesFor(included),
    truncatedProperties: truncated || undefined,
  }
  return { text: renderWhyDossier(input) }
}

/**
 * Parent display feeds the flex/grid-item inactive rules. Prefer the experimental
 * CDP parentLayoutNodeId (feature-detected per SPEC §9); fall back to a scoped JS probe.
 */
async function getParentDisplay(
  ctx: ToolContext,
  nodeId: number,
  parentLayoutNodeId: number | undefined,
): Promise<string | undefined> {
  if (parentLayoutNodeId) {
    const pc = await ctx.cdp.send('CSS.getComputedStyleForNode', { nodeId: parentLayoutNodeId })
    return pc.computedStyle.find((p) => p.name === 'display')?.value
  }
  const { object } = await ctx.cdp.send('DOM.resolveNode', { nodeId })
  if (!object.objectId) return undefined
  try {
    const res = await ctx.cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      returnByValue: true,
      functionDeclaration:
        'function () { var p = this.parentElement; return p ? getComputedStyle(p).display : null }',
    })
    return typeof res.result.value === 'string' ? res.result.value : undefined
  } finally {
    await ctx.cdp.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => undefined)
  }
}

/** Animations are out of scope for v0.1 — note keyframes presence instead (SPEC §6.1a). */
function buildKeyframesNote(
  keyframesRules: Protocol.CSS.CSSKeyframesRule[] | undefined,
  filter: string | undefined,
  family: Set<string> | undefined,
): string | undefined {
  if (!keyframesRules?.length) return undefined
  const names = [...new Set(keyframesRules.map((k) => k.animationName.text))].join(', ')
  if (filter && family) {
    const animated = new Set<string>()
    for (const k of keyframesRules)
      for (const frame of k.keyframes) for (const p of frame.style.cssProperties) animated.add(p.name)
    if (![...family].some((p) => animated.has(p))) return undefined
    return `@keyframes ${names} animates ${filter} — animated values are not modeled in v0.1; verdict reflects the static cascade`
  }
  return `@keyframes present (${names}) — animated values are not modeled in v0.1; verdicts reflect the static cascade`
}
