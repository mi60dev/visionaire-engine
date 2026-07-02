/**
 * explain_animations — SPEC §14.3. Two deterministic halves joined per element:
 * 1. census (active NOW): in-page element.getAnimations() via Runtime.callFunctionOn
 *    — no CDP Animation domain (it carries zero source attribution);
 * 2. declared (even when idle): winning transition/animation longhands + matched
 *    @keyframes rules from CSS.getMatchedStylesForNode, each with file:line +
 *    origin bracket via the same 3-hop attribution join explain_styles uses.
 * Findings come from the closed R1–R6 ruleset in engine/animations.
 */
import { z } from 'zod'
import type { Protocol } from 'puppeteer-core'
import type {
  AnimationCensusEntry,
  AuthoredPos,
  ElementSummary,
  StyleOrigin,
  ToolContext,
  ToolDef,
  ToolResult,
} from '../types.js'
import { estimateTokens } from '../types.js'
import { pairAttributes, resolveTarget } from '../uid.js'
import { computeCascade } from '../engine/cascade.js'
import { findAnimationIssues, serializeAnimationsExpression } from '../engine/animations.js'
import { resolveAuthoredPosition } from '../attribution/sourcemaps.js'

/** Output budget — SPEC §14.3 sketch (~500 tokens). */
const ANIMATIONS_BUDGET_TOKENS = 500

/** Census/keyframes caps tried in order until the render fits the budget. */
const RENDER_CAPS: ReadonlyArray<readonly [number, number]> = [
  [12, 8],
  [6, 4],
  [3, 2],
]

const TRANSITION_LONGHANDS = [
  'transition-property',
  'transition-duration',
  'transition-timing-function',
  'transition-delay',
] as const

const ANIMATION_LONGHANDS = [
  'animation-name',
  'animation-duration',
  'animation-timing-function',
  'animation-delay',
  'animation-iteration-count',
  'animation-direction',
  'animation-fill-mode',
  'animation-play-state',
] as const

/** Specified values equivalent to auto for width/height (R2). */
const AUTO_VALUES = new Set(['auto', 'initial', 'unset', 'revert'])

interface ExplainAnimationsArgs {
  uid?: string
  selector?: string
  x?: number
  y?: number
  property?: string
}

export const explainAnimationsTool: ToolDef = {
  name: 'explain_animations',
  description:
    'Explain animations on an element: what is animating NOW (getAnimations census — type, ' +
    'playState, timing, animated properties) and what is DECLARED even when idle (winning ' +
    'transition/animation rules + @keyframes with file:line origins), plus a closed "not smooth" ' +
    'diagnosis: non-animatable transition properties, the width/height:auto interpolation trap, ' +
    'main-thread (layout/paint) jank risk, missing or zero-duration transitions, and ' +
    'reduced-motion handling. Target by uid (from page_snapshot), CSS selector, or x+y. ' +
    'Pass property to check why THAT property does not animate.',
  inputSchema: {
    uid: z.string().optional().describe('Element uid from a prior page_snapshot / find_elements'),
    selector: z.string().optional().describe('CSS selector (first match) — alternative to uid'),
    x: z.number().optional().describe('Viewport x coordinate — use together with y'),
    y: z.number().optional().describe('Viewport y coordinate — use together with x'),
    property: z
      .string()
      .optional()
      .describe('CSS property you expected to animate — enables the "changes are instant" check'),
  },
  handler: explainAnimations,
}

async function explainAnimations(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const a = args as ExplainAnimationsArgs
  const node = await resolveTarget(ctx, a)

  // ── census half: one in-page evaluate (getAnimations + matchMedia) ──
  let census: AnimationCensusEntry[] = []
  let reducedMotionActive = false
  let censusFailure: string | undefined
  const { object } = await ctx.cdp.send('DOM.resolveNode', { nodeId: node.nodeId })
  if (!object.objectId) {
    censusFailure = 'DOM.resolveNode returned no in-page object for this node'
  } else {
    try {
      const res = await ctx.cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        returnByValue: true,
        functionDeclaration: serializeAnimationsExpression(),
      })
      if (res.exceptionDetails) {
        censusFailure = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text
      } else {
        const value = res.result.value as
          | { census?: AnimationCensusEntry[]; reducedMotionActive?: boolean }
          | undefined
        census = value?.census ?? []
        reducedMotionActive = value?.reducedMotionActive === true
      }
    } finally {
      await ctx.cdp.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => undefined)
    }
  }

  // ── declared half: winning transition/animation longhands via the cascade ──
  const matched = await ctx.cdp.send('CSS.getMatchedStylesForNode', { nodeId: node.nodeId })
  const computedRes = await ctx.cdp.send('CSS.getComputedStyleForNode', { nodeId: node.nodeId })
  const computed = new Map(computedRes.computedStyle.map((p) => [p.name, p.value]))

  // CDP splits the transition/animation shorthands via longhandProperties
  // (verified) — verdicts land on the longhand names either way.
  const verdicts = computeCascade(matched, computed, {
    properties: [...TRANSITION_LONGHANDS, ...ANIMATION_LONGHANDS, 'width', 'height'],
  })
  const winnerOf = (prop: string) => verdicts.find((v) => v.property === prop)?.winner

  const transitionPropertyDecl = winnerOf('transition-property')
  const transitionProperty = parseCommaList(transitionPropertyDecl?.value).filter((p) => p !== 'none')
  const transitionDurationsMs = parseCommaList(winnerOf('transition-duration')?.value).map(parseTimeMs)
  const animationNameDecl = winnerOf('animation-name')
  const animationNames = parseCommaList(animationNameDecl?.value).filter((n) => n !== 'none')

  // R2 gotcha (verified empirically): computed width/height of laid-out elements
  // are used px values, never 'auto' — substitute the cascade-SPECIFIED value so
  // the auto-dimension rule can fire. No authored winner means the initial value: auto.
  const specifiedOrAuto = (prop: string): string => {
    const w = winnerOf(prop)
    if (!w) return 'auto'
    const v = w.value.trim().toLowerCase()
    return AUTO_VALUES.has(v) ? 'auto' : v
  }
  const styleForRules = new Map(computed)
  styleForRules.set('width', specifiedOrAuto('width'))
  styleForRules.set('height', specifiedOrAuto('height'))

  let findings = findAnimationIssues({
    census,
    transitionProperty,
    transitionDurationsMs,
    computed: styleForRules,
    reducedMotionActive,
    expectedProperty: a.property,
  })
  // A failed census proves nothing — suppress the "census empty" honesty rule
  // (R6) and report the failure itself instead.
  if (censusFailure) findings = findings.filter((f) => f.rule !== 'raf-blindness')

  // ── attribution join (same 3-hop approach as explain_styles) ──
  await ctx.sheets.ensureOwnerIds()

  const declaredLines: string[] = []
  if (transitionProperty.length) {
    const loc = await attributeLoc(ctx, transitionPropertyDecl?.styleSheetId, transitionPropertyDecl?.range, transitionPropertyDecl?.selector)
    const timing = [winnerOf('transition-duration')?.value, winnerOf('transition-timing-function')?.value]
      .filter(Boolean)
      .join(' ')
    declaredLines.push(
      `  transition: ${transitionProperty.join(', ')}${timing ? ` — ${timing}` : ''}${locSuffix(loc)}`,
    )
  }
  if (animationNames.length) {
    const loc = await attributeLoc(ctx, animationNameDecl?.styleSheetId, animationNameDecl?.range, animationNameDecl?.selector)
    const iter = winnerOf('animation-iteration-count')?.value
    const timing = [
      winnerOf('animation-duration')?.value,
      winnerOf('animation-timing-function')?.value,
      iter && iter !== '1' ? `×${iter}` : undefined,
    ]
      .filter(Boolean)
      .join(' ')
    declaredLines.push(
      `  animation: ${animationNames.join(', ')}${timing ? ` — ${timing}` : ''}${locSuffix(loc)}`,
    )
  }

  const keyframesLines: string[] = []
  for (const kf of matched.cssKeyframesRules ?? []) {
    // The keyframes rule itself carries no styleSheetId — it lives on each
    // keyframe; the name token's range marks the @keyframes header line (verified).
    const styleSheetId = kf.keyframes[0]?.styleSheetId
    const range = kf.animationName.range ?? kf.keyframes[0]?.style.range
    const loc = await attributeLoc(ctx, styleSheetId, range)
    const props = [...new Set(kf.keyframes.flatMap((f) => f.style.cssProperties.map((p) => p.name)))]
    const propsLabel = props.length ? ` (animates ${props.join(', ')})` : ''
    keyframesLines.push(`  @keyframes ${kf.animationName.text}${propsLabel}${locSuffix(loc)}`)
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

  // ── render within budget ──
  const warnings = findings.filter((f) => f.rule !== 'reduced-motion' && f.rule !== 'raf-blindness')
  const informational = findings.filter((f) => f.rule === 'reduced-motion' || f.rule === 'raf-blindness')

  const build = (censusCap: number, kfCap: number): string => {
    const lines: string[] = [headerLine(element)]

    if (census.length === 0) {
      lines.push('active now: none')
    } else {
      lines.push('active now:')
      for (const e of census.slice(0, censusCap)) lines.push(censusLine(e))
      if (census.length > censusCap) lines.push(`  … +${census.length - censusCap} more active animations`)
    }

    const shownKf = keyframesLines.slice(0, kfCap)
    if (keyframesLines.length > kfCap) shownKf.push(`  … +${keyframesLines.length - kfCap} more @keyframes`)
    const declared = [...declaredLines, ...shownKf]
    if (declared.length === 0) {
      lines.push('declared: none (no transition/animation/@keyframes rules match this element)')
    } else {
      lines.push('declared:')
      lines.push(...declared)
    }

    if (warnings.length) {
      lines.push('findings:')
      for (const f of warnings) lines.push(`  ⚠ ${f.reason}${f.fixHint ? ` — fix: ${f.fixHint}` : ''}`)
    }

    const notes: string[] = []
    if (censusFailure) notes.push(`census unavailable (in-page getAnimations() failed: ${censusFailure})`)
    for (const f of informational) notes.push(`${f.reason}${f.fixHint ? ` — ${f.fixHint}` : ''}`)
    if (notes.length) {
      lines.push('notes:')
      for (const n of notes) lines.push(`  - ${n}`)
    }
    return lines.join('\n')
  }

  let text = ''
  for (const [censusCap, kfCap] of RENDER_CAPS) {
    text = build(censusCap, kfCap)
    if (estimateTokens(text) <= ANIMATIONS_BUDGET_TOKENS) break
  }
  return { text }
}

// ───────────────────────── attribution (local copy) ─────────────────────────
// Small local copy of explain_styles' attribution join + dossier's location
// conventions — those helpers are module-private and both files are frozen for
// this increment; keep formats in lockstep with src/format/dossier.ts.

interface AttributedLoc {
  origin?: StyleOrigin
  authored?: AuthoredPos
  sheetSourceURL?: string
  range?: Protocol.CSS.SourceRange
}

async function attributeLoc(
  ctx: ToolContext,
  styleSheetId: string | undefined,
  range: Protocol.CSS.SourceRange | undefined,
  selector?: string,
): Promise<AttributedLoc> {
  const out: AttributedLoc = { range }
  if (!styleSheetId) return out
  const sheet = ctx.sheets.get(styleSheetId)
  if (!sheet) return out
  if (sheet.sourceURL) out.sheetSourceURL = sheet.sourceURL
  const origin = ctx.sheets.classify(sheet, selector)
  out.origin = origin
  if (origin.granularity === 'line' && sheet.sourceMapURL && range) {
    try {
      // CDP SourceRange is 0-based; sourcemaps module owns trace-mapping base conversion.
      out.authored = await resolveAuthoredPosition(sheet, range.startLine, range.startColumn)
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
  return out
}

/** "  → location  [granularity | label — edit hint]" — empty when neither half resolves. */
function locSuffix(loc: AttributedLoc): string {
  const location = renderLocation(loc)
  const bracket = renderBracket(loc)
  if (!location && !bracket) return ''
  if (!location) return `  → ${bracket}`
  if (!bracket) return `  → ${location}`
  return `  → ${location}  ${bracket}`
}

/** Location preference: authored (source map) > origin.file:line > trimmed sheet URL. */
function renderLocation(loc: AttributedLoc): string | undefined {
  if (loc.authored) return `${loc.authored.file}:${loc.authored.line} (via source map)`
  // CDP ranges are 0-based; rendered locations are 1-based. StyleOrigin.line is already 1-based.
  const rangeLine = loc.range ? loc.range.startLine + 1 : undefined
  const o = loc.origin
  if (o?.file) {
    // 'file' granularity means the line is unreliable (minified, no map) — don't print one.
    const line = o.line ?? (o.granularity === 'line' ? rangeLine : undefined)
    const file = /:\/\//.test(o.file) ? trimUrl(o.file) : o.file
    return file + (line !== undefined ? `:${line}` : '')
  }
  if (loc.sheetSourceURL) return trimUrl(loc.sheetSourceURL) + (rangeLine !== undefined ? `:${rangeLine}` : '')
  return undefined
}

function renderBracket(loc: AttributedLoc): string | undefined {
  const o = loc.origin
  if (!o) return undefined
  const label = o.label ? ` | ${o.label}` : ''
  return `[${o.granularity}${label}${o.editSurface ? ` — ${o.editSurface}` : ''}]`
}

/** Trim a sheet URL to its last 3 path segments — same convention as dossier.ts. */
function trimUrl(url: string): string {
  let path = url
  try {
    path = new URL(url).pathname
  } catch {
    // not a parseable URL — trim the raw string
  }
  const segs = path.split('/').filter(Boolean)
  if (!segs.length) return url
  const tail = segs.slice(-3).join('/')
  return segs.length > 3 ? `…/${tail}` : tail
}

// ───────────────────────── rendering helpers ─────────────────────────

function headerLine(el: ElementSummary): string {
  const id = el.attrId ? `#${el.attrId}` : ''
  const cls = el.classes.length ? `.${el.classes.slice(0, 3).join('.')}` : ''
  const text = el.text?.trim() ? ` "${truncate(el.text.trim(), 40)}"` : ''
  return `animations on ${el.uid} <${el.tag}${id}${cls}>${text}`
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** One active-census line: kind 'name' — playState — timing — properties — position. */
function censusLine(e: AnimationCensusEntry): string {
  const parts: string[] = [`${e.kind} '${e.name || '(anonymous)'}'`, e.playState]
  let timing = `${fmtMs(e.durationMs)} ${e.easing}`
  if (e.delayMs) timing += ` delay ${fmtMs(e.delayMs)}`
  if (e.iterations !== 1) timing += ` ×${e.iterations === 'infinite' ? '∞' : e.iterations}`
  if (e.fill !== 'none' && e.fill !== 'auto') timing += ` fill:${e.fill}`
  parts.push(timing)
  if (e.properties.length) parts.push(`animates ${e.properties.join(', ')}`)
  if (e.currentTimeMs !== null) parts.push(`t=${fmtMs(e.currentTimeMs)}`)
  return `  ${parts.join(' — ')}`
}

function fmtMs(ms: number): string {
  if (Math.abs(ms) >= 1000) {
    const s = Math.round(ms / 100) / 10
    return `${Number.isInteger(s) ? s.toFixed(0) : s.toFixed(1)}s`
  }
  return `${Math.round(ms)}ms`
}

// ───────────────────────── CSS value parsing ─────────────────────────

function parseCommaList(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

/** '300ms' → 300, '0.3s' → 300; unparseable tokens → 0. */
function parseTimeMs(token: string): number {
  const m = /^(-?\d*\.?\d+)(ms|s)$/i.exec(token.trim())
  if (!m) return 0
  const n = Number(m[1])
  return m[2]!.toLowerCase() === 's' ? n * 1000 : n
}
