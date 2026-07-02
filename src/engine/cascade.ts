/**
 * Cascade verdict engine — SPEC §6.1, the wedge.
 * Reimplements DevTools' client-side winner resolution over the raw
 * CSS.getMatchedStylesForNode payload: per-longhand winner + tagged losers.
 */
import type { Protocol } from 'puppeteer-core'
import type {
  DeclarationInfo,
  DeclOriginType,
  LossReason,
  PropertyVerdict,
  Specificity,
} from '../types.js'
import { compareSpecificity, computeSpecificity } from './specificity.js'

const ZERO_SPEC: Specificity = { a: 0, b: 0, c: 0 }

/**
 * CDP's CSSProperty.value for important declarations already carries the
 * ' !important' suffix; DeclarationInfo.value must be the bare value or
 * renderers double it ('1px !important !important').
 */
function stripImportant(value: string): string {
  return value.replace(/\s*!\s*important\s*$/i, '')
}

const SIDES = ['top', 'right', 'bottom', 'left'] as const

/**
 * Static shorthand → covered-longhand map (SPEC §6.1 step 2). Values are NOT
 * split per longhand — for verdict purposes what matters is WHICH declaration
 * wins a longhand; the shorthand's raw value is carried with fromShorthand set.
 * `background` maps to background-color only — a deliberate simplification:
 * verdicts only need the color channel of that family in v0.1.
 */
const SHORTHAND_MAP: Readonly<Record<string, readonly string[]>> = {
  margin: SIDES.map((s) => `margin-${s}`),
  padding: SIDES.map((s) => `padding-${s}`),
  inset: [...SIDES],
  gap: ['row-gap', 'column-gap'],
  border: SIDES.flatMap((s) => [`border-${s}-width`, `border-${s}-style`, `border-${s}-color`]),
  'border-width': SIDES.map((s) => `border-${s}-width`),
  'border-style': SIDES.map((s) => `border-${s}-style`),
  'border-color': SIDES.map((s) => `border-${s}-color`),
  'border-top': ['border-top-width', 'border-top-style', 'border-top-color'],
  'border-right': ['border-right-width', 'border-right-style', 'border-right-color'],
  'border-bottom': ['border-bottom-width', 'border-bottom-style', 'border-bottom-color'],
  'border-left': ['border-left-width', 'border-left-style', 'border-left-color'],
  background: ['background-color'],
  font: ['font-size', 'font-family', 'font-weight', 'line-height'],
  flex: ['flex-grow', 'flex-shrink', 'flex-basis'],
  'flex-flow': ['flex-direction', 'flex-wrap'],
  overflow: ['overflow-x', 'overflow-y'],
  'place-items': ['align-items', 'justify-items'],
  'place-content': ['align-content', 'justify-content'],
  'place-self': ['align-self', 'justify-self'],
  'text-decoration': ['text-decoration-line', 'text-decoration-style', 'text-decoration-color'],
  outline: ['outline-width', 'outline-style', 'outline-color'],
  'list-style': ['list-style-type', 'list-style-position', 'list-style-image'],
  columns: ['column-width', 'column-count'],
  'grid-row': ['grid-row-start', 'grid-row-end'],
  'grid-column': ['grid-column-start', 'grid-column-end'],
  'grid-area': ['grid-row-start', 'grid-column-start', 'grid-row-end', 'grid-column-end'],
}

/** Standard inherited-property list from SPEC §6.1 step 1e (checked post-expansion). */
const INHERITED_EXACT = new Set([
  'color', 'font', 'line-height', 'letter-spacing', 'text-align', 'text-transform',
  'white-space', 'visibility', 'cursor', 'list-style', 'direction', 'quotes',
  'orphans', 'widows', 'caption-side', 'border-collapse', 'border-spacing',
  'empty-cells', 'tab-size',
])
const INHERITED_PREFIXES = ['font-', 'list-style-', 'word-']

function isInheritable(property: string): boolean {
  if (property.startsWith('--')) return true // custom properties inherit
  if (INHERITED_EXACT.has(property)) return true
  return INHERITED_PREFIXES.some((p) => property.startsWith(p))
}

/** Origin used for bucket math — kept separate from the reported originType so
 * UA rules on ancestors still bucket as UA within their distance group. */
type BucketOrigin = 'user-agent' | 'inline' | 'author'

/**
 * Origin+importance buckets, higher wins (SPEC §6.1 step 3.1):
 * UA normal < author normal < inline normal < author !important
 * < inline !important < UA !important.
 * Injected/inspector sheets bucket with author. Each bucket has uniform importance.
 */
function bucketOf(origin: BucketOrigin, important: boolean): number {
  if (origin === 'user-agent') return important ? 5 : 0
  if (origin === 'inline') return important ? 4 : 2
  return important ? 3 : 1
}

interface Candidate {
  decl: DeclarationInfo
  /** 0 = declared on the element itself; n = nth ancestor up the inherited chain. */
  distance: number
  /** Monotonic collection index in ascending cascade priority; larger wins order ties. */
  order: number
  bucket: number
}

interface RuleCtx {
  selector?: string
  specificity?: Specificity
  /** Layer name chain, outermost→innermost, dot-joined. undefined = unlayered. */
  layerChain?: string
  media?: string
  /** Fallback when the style block itself carries no styleSheetId. */
  styleSheetId?: string
}

export function computeCascade(
  matched: Protocol.CSS.GetMatchedStylesForNodeResponse,
  computed: Map<string, string>,
  opts?: { properties?: string[] },
): PropertyVerdict[] {
  const candidates: Candidate[] = []
  const counter = { order: 0 }

  const addRules = (rules: Protocol.CSS.RuleMatch[] | undefined, distance: number): void => {
    if (!rules) return
    // CDP orders matchedCSSRules by ascending cascade priority — array index is
    // exactly the source-order tiebreak (later index wins ties).
    for (const rm of rules) {
      const rule = rm.rule
      const selIdx = rm.matchingSelectors[0]
      const sel = selIdx !== undefined ? rule.selectorList.selectors[selIdx] : undefined
      const selectorText = sel?.text ?? rule.selectorList.text
      // Experimental CDP specificity field when present, else our own parser (SPEC §9).
      const specificity = sel?.specificity ?? computeSpecificity(selectorText)
      const layerChain =
        rule.layers && rule.layers.length > 0
          ? [...rule.layers].reverse().map((l) => l.text).join('.') // CDP: innermost first
          : undefined
      // rule.media also carries media="" attributes of <link>/<style>; only
      // source 'mediaRule' is a real @media block worth reporting.
      const mediaTexts = (rule.media ?? []).filter((m) => m.source === 'mediaRule').map((m) => m.text)
      const media = mediaTexts.length > 0 ? mediaTexts.join(' and ') : undefined

      const bucketOrigin: BucketOrigin = rule.origin === 'user-agent' ? 'user-agent' : 'author'
      const originType: DeclOriginType =
        distance > 0
          ? 'inherited'
          : rule.origin === 'user-agent'
            ? 'user-agent'
            : rule.origin === 'regular'
              ? 'matched'
              : 'injected' // 'injected' and 'inspector' both — non-page-authored sheets
      addStyle(candidates, counter, rule.style, originType, bucketOrigin, distance, {
        selector: selectorText,
        specificity,
        layerChain,
        media,
        styleSheetId: rule.styleSheetId,
      })
    }
  }

  // Element's own declarations, collected in ascending cascade priority:
  // presentational attribute style < matched rules < inline style.
  addStyle(candidates, counter, matched.attributesStyle, 'attribute', 'author', 0)
  addRules(matched.matchedCSSRules, 0)
  addStyle(candidates, counter, matched.inlineStyle, 'inline', 'inline', 0)

  // inherited[]: nearest ancestor first → distance 1, 2, …
  matched.inherited?.forEach((entry, i) => {
    const distance = i + 1
    addRules(entry.matchedCSSRules, distance)
    addStyle(candidates, counter, entry.inlineStyle, 'inherited-inline', 'inline', distance)
  })

  // opts.properties filter, including the shorthand family: asking for 'margin'
  // admits all margin-* longhands; asking for 'margin-bottom' still sees candidates
  // expanded from 'margin' because candidates are keyed by longhand name.
  let allowed: Set<string> | undefined
  if (opts?.properties && opts.properties.length > 0) {
    allowed = new Set<string>()
    for (const p of opts.properties) {
      const name = p.toLowerCase()
      allowed.add(name)
      for (const lh of SHORTHAND_MAP[name] ?? []) allowed.add(lh)
    }
  }

  const byProperty = new Map<string, Candidate[]>()
  for (const cand of candidates) {
    if (allowed && !allowed.has(cand.decl.property)) continue
    const list = byProperty.get(cand.decl.property)
    if (list) list.push(cand)
    else byProperty.set(cand.decl.property, [cand])
  }

  const verdicts: PropertyVerdict[] = []
  for (const [property, cands] of byProperty) {
    cands.sort((x, y) => compareCandidates(y, x)) // descending priority
    const winner = cands[0]!
    const losers = cands.slice(1).map((cand) => ({
      decl: cand.decl,
      reason: decisiveReason(cand, winner),
    }))
    const computedValue = computed.get(property)
    const verdict: PropertyVerdict = { property, winner: winner.decl, losers, computedValue }
    if (
      computedValue !== undefined &&
      winner.decl.value.trim() !== computedValue.trim() &&
      losers.some((l) => l.decl.value.trim() === computedValue.trim())
    ) {
      // Winner merely differing from computed is usually unit/keyword resolution
      // ('50%' → '342px'); only when a DIFFERENT candidate matches computed exactly
      // is our prediction suspect — flag, never guess (SPEC §9).
      verdict.uncertain = true
    }
    verdicts.push(verdict)
  }
  return verdicts
}

/**
 * Ingest one CSSStyle block as candidates. Handles shorthand expansion,
 * within-block duplicate resolution, and Chrome's synthetic longhand entries.
 */
function addStyle(
  acc: Candidate[],
  counter: { order: number },
  cssStyle: Protocol.CSS.CSSStyle | undefined,
  originType: DeclOriginType,
  bucketOrigin: BucketOrigin,
  distance: number,
  ruleCtx: RuleCtx = {},
): void {
  if (!cssStyle) return
  const order = counter.order++
  const perLonghand = new Map<string, DeclarationInfo>()
  const covered = new Set<string>()

  const put = (decl: DeclarationInfo): void => {
    // Inherited candidates exist only for inheritable longhands (SPEC §6.1 step 1e).
    if (distance > 0 && !isInheritable(decl.property)) return
    const prev = perLonghand.get(decl.property)
    // Within one declaration block: later wins, but normal never overrides !important.
    if (prev && prev.important && !decl.important) return
    perLonghand.set(decl.property, decl)
  }

  for (const p of cssStyle.cssProperties) {
    if (p.parsedOk === false) continue
    if (p.disabled) continue // commented-out in DevTools — never applies
    // Chrome appends a synthetic normalized entry (no text/range) after EVERY
    // authored declaration — longhands included, not just shorthand expansions.
    // Our authored pass already recorded those names in `covered`; letting the
    // synthetic through would overwrite the authored entry via later-wins put(),
    // losing range attribution (file:line) and de-normalizing authored values.
    if (p.text === undefined && p.range === undefined && covered.has(p.name)) continue

    const base = {
      important: p.important === true,
      originType,
      selector: ruleCtx.selector,
      specificity: ruleCtx.specificity,
      layer: ruleCtx.layerChain,
      media: ruleCtx.media,
      styleSheetId: cssStyle.styleSheetId ?? ruleCtx.styleSheetId,
      range: p.range,
    }

    if (p.longhandProperties && p.longhandProperties.length > 0) {
      // CDP already split the shorthand — its per-longhand values beat our static map.
      for (const lh of p.longhandProperties) {
        covered.add(lh.name)
        put({
          ...base,
          property: lh.name,
          value: stripImportant(lh.value),
          important: lh.important === true || p.important === true,
          fromShorthand: p.name,
        })
      }
      continue
    }
    const longhands = SHORTHAND_MAP[p.name]
    if (longhands) {
      for (const lh of longhands) {
        covered.add(lh)
        put({ ...base, property: lh, value: stripImportant(p.value), fromShorthand: p.name })
      }
      continue
    }
    covered.add(p.name) // authored longhand — shields against Chrome's trailing synthetic
    put({ ...base, property: p.name, value: stripImportant(p.value) })
  }

  for (const decl of perLonghand.values()) {
    acc.push({ decl, distance, order, bucket: bucketOf(bucketOrigin, decl.important) })
  }
}

/** >0 when x beats y. SPEC §6.1 step 3 with one reordering, see first comment. */
function compareCandidates(x: Candidate, y: Candidate): number {
  // Inheritance is defaulting, not cascade: any declaration on the element beats
  // any inherited one, and only the nearest ancestor's computed value inherits.
  // SPEC lists proximity last but also mandates "any direct beats any inherited",
  // which is only satisfiable when proximity is decided first (e.g. a direct
  // normal declaration must beat an ancestor's !important one).
  if (x.distance !== y.distance) return y.distance - x.distance

  if (x.bucket !== y.bucket) return x.bucket - y.bucket

  const xLayer = x.decl.layer
  const yLayer = y.decl.layer
  if ((xLayer === undefined) !== (yLayer === undefined)) {
    // Unlayered beats layered for normal declarations; reversed for !important.
    // Bucket equality guarantees x and y share the same importance here.
    const xWins = (xLayer === undefined) !== x.decl.important
    return xWins ? 1 : -1
  }
  if (xLayer !== undefined && yLayer !== undefined && xLayer !== yLayer) {
    // CDP does not expose @layer statement order; lexicographic chain compare is
    // a deterministic proxy (later chain ≈ later-declared: wins normal, loses important).
    const cmp = xLayer < yLayer ? -1 : 1
    return x.decl.important ? -cmp : cmp
  }

  const spec = compareSpecificity(x.decl.specificity ?? ZERO_SPEC, y.decl.specificity ?? ZERO_SPEC)
  if (spec !== 0) return spec

  return x.order - y.order // later in cascade-priority collection wins
}

/** First decisive criterion (in comparator order) by which the loser lost. */
function decisiveReason(loser: Candidate, winner: Candidate): LossReason {
  if (loser.distance !== winner.distance) return 'inherited-distance'
  if (loser.bucket !== winner.bucket) {
    if (loser.decl.important !== winner.decl.important) return 'importance'
    if (loser.bucket === 0 || loser.bucket === 5 || winner.bucket === 0 || winner.bucket === 5) {
      return 'origin'
    }
    return 'inline' // same importance, author level: inline style beat a matched rule
  }
  if (loser.decl.layer !== winner.decl.layer) return 'layer'
  if (
    compareSpecificity(
      loser.decl.specificity ?? ZERO_SPEC,
      winner.decl.specificity ?? ZERO_SPEC,
    ) !== 0
  ) {
    return 'specificity'
  }
  return 'order'
}
