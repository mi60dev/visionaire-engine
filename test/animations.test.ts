import { describe, expect, it } from 'vitest'
import {
  COMPOSITOR_FRIENDLY_PROPS,
  findAnimationIssues,
  NON_ANIMATABLE_PROPS,
  serializeAnimationsExpression,
  type AnimationIssueInput,
} from '../src/engine/animations.js'
import type { AnimationCensusEntry, AnimationFinding } from '../src/types.js'

function entry(partial: Partial<AnimationCensusEntry> = {}): AnimationCensusEntry {
  return {
    kind: 'CSSAnimation',
    name: 'spin',
    playState: 'running',
    currentTimeMs: 0,
    durationMs: 1000,
    delayMs: 0,
    easing: 'linear',
    iterations: 1,
    fill: 'none',
    properties: ['transform'],
    ...partial,
  }
}

function run(partial: Partial<AnimationIssueInput> = {}): AnimationFinding[] {
  return findAnimationIssues({
    census: [],
    computed: new Map(),
    reducedMotionActive: false,
    ...partial,
  })
}

const ofRule = (findings: AnimationFinding[], rule: AnimationFinding['rule']): AnimationFinding[] =>
  findings.filter((f) => f.rule === rule)

describe('findAnimationIssues', () => {
  // ── R1 non-animatable ──
  it('R1: flags display in transition-property with the @starting-style hint', () => {
    const findings = ofRule(run({ transitionProperty: ['display'] }), 'non-animatable')
    expect(findings).toHaveLength(1)
    expect(findings[0]!.property).toBe('display')
    expect(findings[0]!.reason).toContain('display')
    expect(findings[0]!.reason).toContain('kills transitions')
    expect(findings[0]!.fixHint).toContain('@starting-style')
  })

  it('R1: flags visibility as discrete-only, hinting at an opacity pairing', () => {
    const findings = ofRule(run({ transitionProperty: ['visibility'] }), 'non-animatable')
    expect(findings).toHaveLength(1)
    expect(findings[0]!.reason).toContain('discrete')
    expect(findings[0]!.fixHint).toContain('opacity')
  })

  it('R1: flags font-family but not transform', () => {
    const findings = run({ transitionProperty: ['font-family', 'transform'] })
    expect(ofRule(findings, 'non-animatable').map((f) => f.property)).toEqual(['font-family'])
    expect(findings.some((f) => f.property === 'transform')).toBe(false)
  })

  // ── R2 auto-dimension ──
  it('R2: the height:auto trap — flags it and does NOT also flag height as main-thread', () => {
    const findings = run({
      transitionProperty: ['height'],
      transitionDurationsMs: [300],
      computed: new Map([['height', 'auto']]),
    })
    const auto = ofRule(findings, 'auto-dimension')
    expect(auto).toHaveLength(1)
    expect(auto[0]!.property).toBe('height')
    expect(auto[0]!.reason).toContain('cannot interpolate to/from auto')
    expect(auto[0]!.reason).toContain('jumps')
    expect(ofRule(findings, 'main-thread')).toHaveLength(0) // first matching rule wins
  })

  it('R2: fires for a census-active width transition when width is auto', () => {
    const findings = run({
      census: [entry({ kind: 'CSSTransition', name: 'width', properties: ['width'] })],
      computed: new Map([['width', 'auto']]),
    })
    const auto = ofRule(findings, 'auto-dimension')
    expect(auto).toHaveLength(1)
    expect(auto[0]!.property).toBe('width')
  })

  it("R2: 'transition: all' covers the auto height, but 'all' is not main-thread-flagged", () => {
    const findings = run({
      transitionProperty: ['all'],
      computed: new Map([
        ['height', 'auto'],
        ['width', '100px'],
      ]),
    })
    expect(ofRule(findings, 'auto-dimension').map((f) => f.property)).toEqual(['height'])
    expect(ofRule(findings, 'main-thread')).toHaveLength(0)
    expect(ofRule(findings, 'non-animatable')).toHaveLength(0)
  })

  // ── R3 main-thread ──
  it('R3: an explicit height with a set value is main-thread, not auto-dimension', () => {
    const findings = run({
      transitionProperty: ['height'],
      computed: new Map([['height', '200px']]),
    })
    expect(ofRule(findings, 'auto-dimension')).toHaveLength(0)
    const main = ofRule(findings, 'main-thread')
    expect(main).toHaveLength(1)
    expect(main[0]!.property).toBe('height')
    expect(main[0]!.reason).toContain('main thread')
    expect(main[0]!.fixHint).toContain('transform')
  })

  it('R3: flags a census animation over background-color', () => {
    const findings = run({
      census: [entry({ name: 'flash', properties: ['background-color'] })],
    })
    const main = ofRule(findings, 'main-thread')
    expect(main).toHaveLength(1)
    expect(main[0]!.property).toBe('background-color')
  })

  it('R3: compositor-friendly properties (transform, opacity, filter…) are never flagged', () => {
    const findings = run({
      census: [entry({ properties: ['transform', 'opacity'] })],
      transitionProperty: ['filter', 'backdrop-filter', 'rotate', 'scale', 'translate'],
    })
    expect(findings).toHaveLength(0) // census non-empty → no R6 either: truly clean
  })

  // ── R4 no-transition ──
  it('R4: expected property with no coverage at all → "instant by design"', () => {
    const findings = run({ expectedProperty: 'opacity' })
    const r4 = ofRule(findings, 'no-transition')
    expect(r4).toHaveLength(1)
    expect(r4[0]!.property).toBe('opacity')
    expect(r4[0]!.reason).toContain('instant by design')
    expect(r4[0]!.fixHint).toContain('transition')
  })

  it('R4: zero duration via CSS list-repeat counts as instant', () => {
    // durations [300, 0] with properties [width, height]: height pairs with 0.
    const findings = run({
      transitionProperty: ['width', 'height'],
      transitionDurationsMs: [300, 0],
      computed: new Map([
        ['width', '10px'],
        ['height', '10px'],
      ]),
      expectedProperty: 'height',
    })
    const r4 = ofRule(findings, 'no-transition')
    expect(r4).toHaveLength(1)
    expect(r4[0]!.reason).toContain('0s')
  })

  it('R4: does not fire when the expected property is covered with a real duration', () => {
    const findings = run({
      transitionProperty: ['height'],
      transitionDurationsMs: [300],
      computed: new Map([['height', '10px']]),
      expectedProperty: 'height',
    })
    expect(ofRule(findings, 'no-transition')).toHaveLength(0)
  })

  it('R4: an uncovered non-animatable expected property gets the R1 diagnosis, not "add a transition"', () => {
    const findings = run({ expectedProperty: 'display' })
    expect(ofRule(findings, 'no-transition')).toHaveLength(0)
    const r1 = ofRule(findings, 'non-animatable')
    expect(r1).toHaveLength(1)
    expect(r1[0]!.property).toBe('display')
  })

  // ── R5 reduced-motion (informational) ──
  it('R5: informs when reduce is active and animations still run', () => {
    const findings = run({ census: [entry()], reducedMotionActive: true })
    const r5 = ofRule(findings, 'reduced-motion')
    expect(r5).toHaveLength(1)
    expect(r5[0]!.reason).toContain('prefers-reduced-motion')
    expect(r5[0]!.reason).toContain('informational')
    expect(r5[0]!.fixHint).toContain('no-preference')
  })

  it('R5: silent when reduce is active but the element has no motion at all', () => {
    const findings = run({ reducedMotionActive: true })
    expect(ofRule(findings, 'reduced-motion')).toHaveLength(0)
  })

  // ── R6 rAF blindness ──
  it('R6: an empty census yields the honesty note pointing at record_interaction', () => {
    const findings = run()
    const r6 = ofRule(findings, 'raf-blindness')
    expect(r6).toHaveLength(1)
    expect(r6[0]!.reason).toContain('requestAnimationFrame')
    expect(r6[0]!.fixHint).toContain('record_interaction')
  })

  it('R6: absent when the census has entries', () => {
    const findings = run({ census: [entry()] })
    expect(ofRule(findings, 'raf-blindness')).toHaveLength(0)
  })
})

describe('rule constants', () => {
  it('documented property sets match SPEC §14.3', () => {
    expect([...NON_ANIMATABLE_PROPS].sort()).toEqual(
      ['display', 'flex-direction', 'float', 'font-family', 'grid-template-areas', 'position', 'visibility'].sort(),
    )
    expect([...COMPOSITOR_FRIENDLY_PROPS].sort()).toEqual(
      ['backdrop-filter', 'filter', 'opacity', 'rotate', 'scale', 'translate', 'transform'].sort(),
    )
  })
})

describe('serializeAnimationsExpression', () => {
  it('returns parseable function source covering the census contract', () => {
    const src = serializeAnimationsExpression()
    expect(src).toContain('getAnimations')
    expect(src).toContain('prefers-reduced-motion')
    expect(src).toContain("'infinite'") // Infinity does not survive returnByValue JSON
    // Must parse as a standalone function expression (Runtime.callFunctionOn contract).
    const fn = new Function(`return (${src})`)()
    expect(typeof fn).toBe('function')
  })
})
