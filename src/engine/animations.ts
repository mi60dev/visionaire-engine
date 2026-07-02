/**
 * Animation diagnosis engine — SPEC §14.3, the pure half of explain_animations.
 * The closed "not smooth" ruleset R1–R6 over the in-page getAnimations() census
 * + declared transition longhands + computed styles, plus the serialized census
 * expression the tool runs via Runtime.callFunctionOn.
 * One table entry per rule — same style as engine/inactive.ts.
 */
import type { AnimationCensusEntry, AnimationFinding } from '../types.js'

/**
 * R1 — properties that do not smoothly interpolate in a transition (closed,
 * documented list). All of these flip discretely instead of animating:
 * - display/position/float/font-family/flex-direction/grid-template-areas
 *   change layout mode wholesale — there is nothing to interpolate;
 * - visibility IS animatable, but only as a discrete flip (the spec keeps the
 *   element visible for the whole transition) — flagged with a softer hint.
 */
export const NON_ANIMATABLE_PROPS = new Set([
  'display',
  'position',
  'float',
  'visibility',
  'font-family',
  'flex-direction',
  'grid-template-areas',
])

/**
 * R3 — compositor-friendly properties. Everything else animates on the main
 * thread (layout/paint each frame). Static classification only in v0.3;
 * authoritative trace-based compositor-failure reasons are v0.4 (SPEC §14.3).
 */
export const COMPOSITOR_FRIENDLY_PROPS = new Set([
  'transform',
  'opacity',
  'filter',
  'backdrop-filter',
  'rotate',
  'scale',
  'translate',
])

export interface AnimationIssueInput {
  /** In-page element.getAnimations() census (may be empty). */
  census: AnimationCensusEntry[]
  /** Longhands the element declares transitions for (winning transition-property list; may contain 'all'). */
  transitionProperty?: string[]
  /** Durations aligned to transitionProperty — CSS list-repeat semantics apply on length mismatch. */
  transitionDurationsMs?: number[]
  /**
   * Style map for the rule predicates. R2 gotcha (verified empirically):
   * getComputedStyle resolves width/height of laid-out elements to used px
   * values, NEVER 'auto' — the caller must substitute the SPECIFIED value
   * (cascade winner, or 'auto' when unset) for width/height or R2 cannot fire.
   */
  computed: Map<string, string>
  /** matchMedia('(prefers-reduced-motion: reduce)').matches at census time. */
  reducedMotionActive: boolean
  /** The property the user expected to animate — enables R4. */
  expectedProperty?: string
}

interface RuleCtx {
  computed: Map<string, string>
  /** Explicitly declared transition-property longhands ('all'/'none' excluded). */
  declared: Set<string>
  /** Properties animated by active census entries. */
  active: Set<string>
}

interface PropertyRule {
  rule: AnimationFinding['rule']
  match: (prop: string, ctx: RuleCtx) => boolean
  reason: (prop: string, ctx: RuleCtx) => string
  fixHint: (prop: string, ctx: RuleCtx) => string | undefined
}

/** R1 — non-animatable / discrete property in transition-property. */
const R1_NON_ANIMATABLE: PropertyRule = {
  rule: 'non-animatable',
  match: (p) => NON_ANIMATABLE_PROPS.has(p),
  reason: (p) =>
    p === 'display'
      ? `toggling 'display' kills transitions on this element — display is not animatable; the change snaps`
      : p === 'visibility'
        ? `'visibility' only animates as a discrete flip — it has no smooth interpolation by itself`
        : `'${p}' is not smoothly animatable — it flips discretely mid-transition instead of interpolating`,
  fixHint: (p) =>
    p === 'display'
      ? 'transition visibility/opacity instead, or use @starting-style + transition-behavior: allow-discrete'
      : p === 'visibility'
        ? 'pair it with an opacity transition for the visible fade'
        : 'animate a continuous property (transform, opacity) instead',
}

/** R2 — the auto-dimension trap: transition covers width/height but the value is auto. */
const R2_AUTO_DIMENSION: PropertyRule = {
  rule: 'auto-dimension',
  match: (p, ctx) => (p === 'width' || p === 'height') && ctx.computed.get(p) === 'auto',
  reason: (p) =>
    `transition covers '${p}' but its value is auto — cannot interpolate to/from auto; it jumps`,
  fixHint: (p) =>
    `set an explicit ${p}, animate ${p === 'height' ? 'max-height or grid-template-rows' : 'max-width or grid-template-columns'}, or use interpolate-size: allow-keywords`,
}

/** R3 — main-thread property: not in the compositor-friendly set. */
const R3_MAIN_THREAD: PropertyRule = {
  rule: 'main-thread',
  match: (p) => !COMPOSITOR_FRIENDLY_PROPS.has(p),
  reason: (p) =>
    `'${p}' animates on the main thread (layout/paint each frame) — jank risk under load`,
  fixHint: () => 'prefer transform or opacity, which run on the compositor',
}

/** First matching table entry wins per property (mirrors engine/inactive.ts). */
const PROPERTY_RULES: PropertyRule[] = [R1_NON_ANIMATABLE, R2_AUTO_DIMENSION, R3_MAIN_THREAD]

export function findAnimationIssues(input: AnimationIssueInput): AnimationFinding[] {
  const declaredList = (input.transitionProperty ?? []).map((p) => p.trim().toLowerCase()).filter(Boolean)
  const declared = new Set(declaredList.filter((p) => p !== 'all' && p !== 'none'))
  const active = new Set<string>()
  for (const entry of input.census) for (const p of entry.properties) active.add(p.toLowerCase())

  const ctx: RuleCtx = { computed: input.computed, declared, active }
  const findings: AnimationFinding[] = []

  // ── R1–R3 over explicitly animated properties, first matching rule each ──
  const explicit = [...new Set([...declared, ...active])]
  for (const prop of explicit) {
    for (const rule of PROPERTY_RULES) {
      if (rule.match(prop, ctx)) {
        findings.push({
          rule: rule.rule,
          property: prop,
          reason: rule.reason(prop, ctx),
          fixHint: rule.fixHint(prop, ctx),
        })
        break
      }
    }
  }

  // 'transition-property: all' implicitly covers width/height — those get the
  // R2 auto check only (flagging everything 'all' covers as main-thread would
  // be noise about properties that may never change).
  if (declaredList.includes('all')) {
    for (const prop of ['width', 'height']) {
      if (!explicit.includes(prop) && R2_AUTO_DIMENSION.match(prop, ctx)) {
        findings.push({
          rule: R2_AUTO_DIMENSION.rule,
          property: prop,
          reason: R2_AUTO_DIMENSION.reason(prop, ctx),
          fixHint: R2_AUTO_DIMENSION.fixHint(prop, ctx),
        })
      }
    }
  }

  // ── R4 — the property the user expects to animate is uncovered or 0s ──
  const expected = input.expectedProperty?.trim().toLowerCase()
  if (expected) {
    const allIdx = declaredList.indexOf('all')
    const ownIdx = declaredList.indexOf(expected)
    const idx = ownIdx >= 0 ? ownIdx : allIdx
    const covered = idx >= 0 || active.has(expected)
    if (!covered) {
      if (NON_ANIMATABLE_PROPS.has(expected)) {
        // Telling the caller to add `transition: display …` would be a lie —
        // answer with the R1 diagnosis instead.
        findings.push({
          rule: R1_NON_ANIMATABLE.rule,
          property: expected,
          reason: R1_NON_ANIMATABLE.reason(expected, ctx),
          fixHint: R1_NON_ANIMATABLE.fixHint(expected, ctx),
        })
      } else {
        findings.push({
          rule: 'no-transition',
          property: expected,
          reason: `no transition or animation covers '${expected}' — changes to it are instant by design`,
          fixHint: `declare 'transition: ${expected} 200ms' (or an animation) on the element`,
        })
      }
    } else if (idx >= 0 && input.transitionDurationsMs && input.transitionDurationsMs.length > 0) {
      // CSS list-repeat: a short transition-duration list repeats to cover transition-property.
      const durations = input.transitionDurationsMs
      const durationMs = durations[idx % durations.length]!
      if (durationMs === 0) {
        findings.push({
          rule: 'no-transition',
          property: expected,
          reason: `transition-property covers '${expected}' but its transition-duration is 0s — changes are instant by design`,
          fixHint: 'set a non-zero transition-duration for it',
        })
      }
    }
  }

  // ── R5 — reduced motion active yet motion remains (informational) ──
  if (input.reducedMotionActive && (input.census.length > 0 || declared.size > 0 || declaredList.includes('all'))) {
    findings.push({
      rule: 'reduced-motion',
      reason:
        `prefers-reduced-motion: reduce is active, but this element still has ` +
        `${input.census.length > 0 ? 'running animations' : 'declared transitions'} — no reduced-motion handling detected (informational)`,
      fixHint: 'guard motion with @media (prefers-reduced-motion: no-preference) or provide a reduced variant',
    })
  }

  // ── R6 — rAF blindness honesty: an empty census proves nothing ──
  if (input.census.length === 0) {
    findings.push({
      rule: 'raf-blindness',
      reason:
        'no active animations in the getAnimations() census — JS requestAnimationFrame animations are invisible to this census',
      fixHint: 'use record_interaction to observe the change happening',
    })
  }

  return findings
}

/**
 * JS source (a function declaration for Runtime.callFunctionOn with the element
 * as `this`) that maps element.getAnimations() to AnimationCensusEntry[] and
 * samples prefers-reduced-motion in the same evaluate. Returns
 * `{ census: AnimationCensusEntry[], reducedMotionActive: boolean }`.
 *
 * Empirically verified against headless Chrome:
 * - constructor.name distinguishes CSSTransition / CSSAnimation / Animation (WAAPI);
 * - Infinity iterations do NOT survive returnByValue JSON (→ null) — encoded
 *   in-page as the string 'infinite';
 * - getTiming().duration is a number in ms (guarded anyway: 'auto'/CSSNumericValue → 0);
 * - getKeyframes() keys are camelCase ('backgroundColor') — kebab-cased here so
 *   they compare against computed styles and transition-property lists.
 */
export function serializeAnimationsExpression(): string {
  return `function () {
  var kebab = function (p) {
    if (p.indexOf('--') === 0) return p
    if (p === 'cssFloat') return 'float'
    if (p === 'cssOffset') return 'offset'
    return p.replace(/[A-Z]/g, function (m) { return '-' + m.toLowerCase() })
  }
  var anims = typeof this.getAnimations === 'function' ? this.getAnimations() : []
  var census = anims.map(function (a) {
    var ctor = (a.constructor && a.constructor.name) || ''
    var kind = ctor === 'CSSTransition' || ctor === 'CSSAnimation' ? ctor : 'WebAnimation'
    var name = ctor === 'CSSTransition' ? a.transitionProperty
      : ctor === 'CSSAnimation' ? a.animationName
      : (a.id || '')
    var t = null
    var props = []
    if (a.effect) {
      try { t = a.effect.getTiming() } catch (e) {}
      try {
        var seen = {}
        a.effect.getKeyframes().forEach(function (kf) {
          Object.keys(kf).forEach(function (k) {
            if (k === 'offset' || k === 'easing' || k === 'composite' || k === 'computedOffset') return
            seen[kebab(k)] = true
          })
        })
        props = Object.keys(seen)
      } catch (e) {}
    }
    var ct = a.currentTime === null || a.currentTime === undefined ? null : Number(a.currentTime)
    return {
      kind: kind,
      name: name || '',
      playState: String(a.playState),
      currentTimeMs: ct !== null && isFinite(ct) ? ct : null,
      durationMs: t && typeof t.duration === 'number' ? t.duration : 0,
      delayMs: t && typeof t.delay === 'number' ? t.delay : 0,
      easing: (t && t.easing) || 'linear',
      iterations: t && t.iterations === Infinity ? 'infinite'
        : t && typeof t.iterations === 'number' ? t.iterations : 1,
      fill: (t && t.fill) || 'none',
      properties: props,
    }
  })
  return {
    census: census,
    reducedMotionActive: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  }
}`
}
