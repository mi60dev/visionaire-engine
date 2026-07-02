import { describe, expect, it } from 'vitest'
import type { Protocol } from 'puppeteer-core'
import { computeCascade } from '../src/engine/cascade.js'
import { compareSpecificity, computeSpecificity } from '../src/engine/specificity.js'
import type { PropertyVerdict } from '../src/types.js'

type CSSProperty = Protocol.CSS.CSSProperty
type CSSStyle = Protocol.CSS.CSSStyle
type RuleMatch = Protocol.CSS.RuleMatch
type Matched = Protocol.CSS.GetMatchedStylesForNodeResponse

// ───────────────────────── fixture builders ─────────────────────────

let nextLine = 0

function prop(name: string, value: string, extra: Partial<CSSProperty> = {}): CSSProperty {
  const line = nextLine++
  return {
    name,
    value,
    text: `${name}: ${value}${extra.important ? ' !important' : ''};`,
    range: { startLine: line, startColumn: 2, endLine: line, endColumn: 40 },
    ...extra,
  }
}

function style(props: CSSProperty[], extra: Partial<CSSStyle> = {}): CSSStyle {
  return { cssProperties: props, shorthandEntries: [], ...extra }
}

let nextSheet = 0

function ruleMatch(
  selector: string,
  props: CSSProperty[],
  extra: {
    origin?: Protocol.CSS.StyleSheetOrigin
    specificity?: Protocol.CSS.Specificity
    layers?: Protocol.CSS.CSSLayer[]
    media?: Protocol.CSS.CSSMedia[]
  } = {},
): RuleMatch {
  return {
    rule: {
      styleSheetId: `sheet-${++nextSheet}`,
      selectorList: {
        text: selector,
        selectors: [{ text: selector, ...(extra.specificity ? { specificity: extra.specificity } : {}) }],
      },
      origin: extra.origin ?? 'regular',
      style: style(props),
      ...(extra.layers ? { layers: extra.layers } : {}),
      ...(extra.media ? { media: extra.media } : {}),
    },
    matchingSelectors: [0],
  }
}

function payload(o: {
  inline?: CSSStyle
  attributes?: CSSStyle
  rules?: RuleMatch[]
  inherited?: Protocol.CSS.InheritedStyleEntry[]
} = {}): Matched {
  return {
    inlineStyle: o.inline,
    attributesStyle: o.attributes,
    matchedCSSRules: o.rules,
    inherited: o.inherited,
  }
}

function inheritedEntry(rules: RuleMatch[], inline?: CSSStyle): Protocol.CSS.InheritedStyleEntry {
  return { matchedCSSRules: rules, inlineStyle: inline }
}

function cm(entries: Record<string, string> = {}): Map<string, string> {
  return new Map(Object.entries(entries))
}

function verdict(vs: PropertyVerdict[], property: string): PropertyVerdict {
  const v = vs.find((x) => x.property === property)
  if (!v) throw new Error(`no verdict for ${property}; got ${vs.map((x) => x.property).join(', ')}`)
  return v
}

// ───────────────────────── specificity ─────────────────────────

describe('computeSpecificity', () => {
  const cases: Array<[string, { a: number; b: number; c: number }]> = [
    ['div', { a: 0, b: 0, c: 1 }],
    ['*', { a: 0, b: 0, c: 0 }],
    ['#a .b c', { a: 1, b: 1, c: 1 }],
    ['.a.b', { a: 0, b: 2, c: 0 }],
    ['a:hover', { a: 0, b: 1, c: 1 }],
    ['::before', { a: 0, b: 0, c: 1 }],
    [':before', { a: 0, b: 0, c: 1 }],
    ['ul > li + li', { a: 0, b: 0, c: 3 }],
    ['input[type="text"]:focus', { a: 0, b: 2, c: 1 }],
    [':not(#x, .y)', { a: 1, b: 0, c: 0 }],
    [':is(.a, div span)', { a: 0, b: 1, c: 0 }],
    [':where(#a.b)', { a: 0, b: 0, c: 0 }],
    ['#a:not(.b)::first-line', { a: 1, b: 1, c: 1 }],
    ['li:nth-child(2n+1)', { a: 0, b: 1, c: 1 }],
    ['svg|circle', { a: 0, b: 0, c: 1 }],
    ['*|div', { a: 0, b: 0, c: 1 }],
    // strings/parens inside attribute selectors must not confuse the tokenizer
    ['[data-foo="a)b,c"] .x', { a: 0, b: 2, c: 0 }],
    ["[title='it\\'s (fine)']", { a: 0, b: 1, c: 0 }],
    ['a[href$=".pdf"]:not([download])', { a: 0, b: 2, c: 1 }],
  ]
  for (const [selector, expected] of cases) {
    it(`computes ${JSON.stringify(selector)} → (${expected.a},${expected.b},${expected.c})`, () => {
      expect(computeSpecificity(selector)).toEqual(expected)
    })
  }

  it('a selector list takes the max of its members', () => {
    expect(computeSpecificity('#a, .b, div')).toEqual({ a: 1, b: 0, c: 0 })
  })
})

describe('compareSpecificity', () => {
  it('orders lexicographically by (a, b, c)', () => {
    expect(compareSpecificity({ a: 1, b: 0, c: 0 }, { a: 0, b: 9, c: 9 })).toBeGreaterThan(0)
    expect(compareSpecificity({ a: 0, b: 1, c: 0 }, { a: 0, b: 0, c: 9 })).toBeGreaterThan(0)
    expect(compareSpecificity({ a: 0, b: 1, c: 2 }, { a: 0, b: 1, c: 2 })).toBe(0)
    expect(compareSpecificity({ a: 0, b: 0, c: 1 }, { a: 0, b: 1, c: 0 })).toBeLessThan(0)
  })
})

// ───────────────────────── cascade ─────────────────────────

describe('computeCascade', () => {
  it('specificity beats source order', () => {
    const vs = computeCascade(
      payload({
        rules: [
          ruleMatch('.a', [prop('color', 'red')]),
          ruleMatch('div', [prop('color', 'blue')]), // later, but lower specificity
        ],
      }),
      cm({ color: 'red' }),
    )
    const v = verdict(vs, 'color')
    expect(v.winner?.value).toBe('red')
    expect(v.winner?.selector).toBe('.a')
    expect(v.losers).toHaveLength(1)
    expect(v.losers[0]!.reason).toBe('specificity')
    expect(v.computedValue).toBe('red')
    expect(v.uncertain).toBeUndefined()
  })

  it('source order breaks specificity ties (later matchedCSSRules index wins)', () => {
    const vs = computeCascade(
      payload({
        rules: [ruleMatch('.a', [prop('color', 'red')]), ruleMatch('.b', [prop('color', 'blue')])],
      }),
      cm(),
    )
    const v = verdict(vs, 'color')
    expect(v.winner?.value).toBe('blue')
    expect(v.losers[0]!.reason).toBe('order')
  })

  it('uses the experimental CDP specificity field over the parsed selector when present', () => {
    const vs = computeCascade(
      payload({
        rules: [
          // Text says class, CDP says id-level — CDP must win.
          ruleMatch('.low-looking', [prop('color', 'red')], { specificity: { a: 1, b: 0, c: 0 } }),
          ruleMatch('.b.c', [prop('color', 'blue')]),
        ],
      }),
      cm(),
    )
    expect(verdict(vs, 'color').winner?.value).toBe('red')
  })

  it('!important flips author source order', () => {
    const vs = computeCascade(
      payload({
        rules: [
          ruleMatch('.a', [prop('color', 'red', { important: true })]),
          ruleMatch('.b', [prop('color', 'blue')]),
        ],
      }),
      cm(),
    )
    const v = verdict(vs, 'color')
    expect(v.winner?.value).toBe('red')
    expect(v.winner?.important).toBe(true)
    expect(v.losers[0]!.decl.value).toBe('blue')
    expect(v.losers[0]!.reason).toBe('importance')
  })

  it('inline style beats matched author-normal rules', () => {
    const vs = computeCascade(
      payload({
        inline: style([prop('color', 'green')]),
        rules: [ruleMatch('#very.specific', [prop('color', 'red')])],
      }),
      cm(),
    )
    const v = verdict(vs, 'color')
    expect(v.winner?.value).toBe('green')
    expect(v.winner?.originType).toBe('inline')
    expect(v.losers[0]!.reason).toBe('inline')
  })

  it('author !important beats non-important inline style', () => {
    const vs = computeCascade(
      payload({
        inline: style([prop('color', 'green')]),
        rules: [ruleMatch('.a', [prop('color', 'red', { important: true })])],
      }),
      cm(),
    )
    const v = verdict(vs, 'color')
    expect(v.winner?.value).toBe('red')
    expect(v.losers[0]!.decl.originType).toBe('inline')
    expect(v.losers[0]!.reason).toBe('importance')
  })

  it('inline !important beats matched !important', () => {
    const vs = computeCascade(
      payload({
        inline: style([prop('color', 'green', { important: true })]),
        rules: [ruleMatch('.a', [prop('color', 'red', { important: true })])],
      }),
      cm(),
    )
    const v = verdict(vs, 'color')
    expect(v.winner?.value).toBe('green')
    expect(v.losers[0]!.reason).toBe('inline')
  })

  it('user-agent rules lose to author rules regardless of order', () => {
    const vs = computeCascade(
      payload({
        rules: [
          ruleMatch('div', [prop('display', 'inline')], { origin: 'user-agent' }),
          ruleMatch('.a', [prop('display', 'block')]),
        ],
      }),
      cm({ display: 'block' }),
    )
    const v = verdict(vs, 'display')
    expect(v.winner?.value).toBe('block')
    expect(v.losers[0]!.decl.originType).toBe('user-agent')
    expect(v.losers[0]!.reason).toBe('origin')
  })

  it('inherited color from the nearer ancestor wins', () => {
    const vs = computeCascade(
      payload({
        inherited: [
          inheritedEntry([ruleMatch('.parent', [prop('color', 'red')])]),
          inheritedEntry([ruleMatch('#grandparent', [prop('color', 'blue')])]),
        ],
      }),
      cm({ color: 'red' }),
    )
    const v = verdict(vs, 'color')
    expect(v.winner?.value).toBe('red')
    expect(v.winner?.originType).toBe('inherited')
    expect(v.losers[0]!.decl.value).toBe('blue')
    expect(v.losers[0]!.reason).toBe('inherited-distance')
  })

  it('any direct declaration beats any inherited one — even an inherited !important', () => {
    const vs = computeCascade(
      payload({
        rules: [ruleMatch('.self', [prop('color', 'red')])],
        inherited: [inheritedEntry([ruleMatch('#parent', [prop('color', 'blue', { important: true })])])],
      }),
      cm({ color: 'red' }),
    )
    const v = verdict(vs, 'color')
    expect(v.winner?.value).toBe('red')
    expect(v.losers[0]!.reason).toBe('inherited-distance')
  })

  it('inherited candidates exist only for inheritable properties', () => {
    const vs = computeCascade(
      payload({
        inherited: [
          inheritedEntry([ruleMatch('.parent', [prop('margin-top', '5px'), prop('color', 'red')])]),
        ],
      }),
      cm(),
    )
    expect(vs.find((v) => v.property === 'margin-top')).toBeUndefined()
    expect(verdict(vs, 'color').winner?.value).toBe('red')
  })

  it('shorthand margin competes against longhand margin-bottom on the longhand name', () => {
    const vs = computeCascade(
      payload({
        rules: [
          ruleMatch('.a', [prop('margin', '10px')]),
          ruleMatch('.b', [prop('margin-bottom', '20px')]),
        ],
      }),
      cm({ 'margin-bottom': '20px', 'margin-top': '10px' }),
    )
    const bottom = verdict(vs, 'margin-bottom')
    expect(bottom.winner?.value).toBe('20px')
    expect(bottom.losers).toHaveLength(1)
    expect(bottom.losers[0]!.decl.fromShorthand).toBe('margin')
    expect(bottom.losers[0]!.reason).toBe('order')

    const top = verdict(vs, 'margin-top')
    expect(top.winner?.value).toBe('10px')
    expect(top.winner?.fromShorthand).toBe('margin')
    expect(top.losers).toHaveLength(0)
  })

  it('prefers CDP longhandProperties over the static expansion when present', () => {
    const vs = computeCascade(
      payload({
        rules: [
          ruleMatch('.a', [
            prop('margin', '10px 20px', {
              longhandProperties: [
                { name: 'margin-top', value: '10px' },
                { name: 'margin-right', value: '20px' },
                { name: 'margin-bottom', value: '10px' },
                { name: 'margin-left', value: '20px' },
              ],
            }),
          ]),
        ],
      }),
      cm(),
    )
    expect(verdict(vs, 'margin-right').winner?.value).toBe('20px')
    expect(verdict(vs, 'margin-right').winner?.fromShorthand).toBe('margin')
    expect(verdict(vs, 'margin-top').winner?.value).toBe('10px')
  })

  it("skips Chrome's synthetic longhand entries that follow a shorthand", () => {
    const vs = computeCascade(
      payload({
        rules: [
          ruleMatch('.a', [
            prop('margin', '10px'),
            // Synthetic entries: no text, no range — must not duplicate candidates.
            prop('margin-top', '10px', { text: undefined, range: undefined }),
            prop('margin-bottom', '10px', { text: undefined, range: undefined }),
          ]),
        ],
      }),
      cm(),
    )
    const v = verdict(vs, 'margin-top')
    expect(v.winner?.fromShorthand).toBe('margin')
    expect(v.losers).toHaveLength(0)
  })

  it('unlayered beats layered for normal declarations; reversed for !important', () => {
    const normal = computeCascade(
      payload({
        rules: [
          ruleMatch('.a', [prop('color', 'red')]), // unlayered, earlier
          ruleMatch('.b', [prop('color', 'blue')], { layers: [{ text: 'theme' }] }),
        ],
      }),
      cm(),
    )
    const nv = verdict(normal, 'color')
    expect(nv.winner?.value).toBe('red')
    expect(nv.losers[0]!.decl.layer).toBe('theme')
    expect(nv.losers[0]!.reason).toBe('layer')

    const important = computeCascade(
      payload({
        rules: [
          ruleMatch('.a', [prop('color', 'red', { important: true })]),
          ruleMatch('.b', [prop('color', 'blue', { important: true })], {
            layers: [{ text: 'theme' }],
          }),
        ],
      }),
      cm(),
    )
    const iv = verdict(important, 'color')
    expect(iv.winner?.value).toBe('blue')
    expect(iv.winner?.layer).toBe('theme')
    expect(iv.losers[0]!.reason).toBe('layer')
  })

  it('joins nested layer chains outermost→innermost', () => {
    const vs = computeCascade(
      payload({
        rules: [
          // CDP reports layers innermost-first.
          ruleMatch('.a', [prop('color', 'red')], {
            layers: [{ text: 'components' }, { text: 'framework' }],
          }),
        ],
      }),
      cm(),
    )
    expect(verdict(vs, 'color').winner?.layer).toBe('framework.components')
  })

  it('skips disabled and parsedOk:false declarations entirely', () => {
    const vs = computeCascade(
      payload({
        rules: [
          ruleMatch('.b', [prop('color', 'blue')]),
          // Later (higher priority) but disabled / unparsable — must not win, must not appear.
          ruleMatch('.a', [prop('color', 'red', { disabled: true })]),
          ruleMatch('.c', [prop('color', 'grene', { parsedOk: false })]),
        ],
      }),
      cm({ color: 'blue' }),
    )
    const v = verdict(vs, 'color')
    expect(v.winner?.value).toBe('blue')
    expect(v.losers).toHaveLength(0)
  })

  it('within one declaration block, later wins but !important is kept', () => {
    const vs = computeCascade(
      payload({
        rules: [ruleMatch('.a', [prop('color', 'red', { important: true }), prop('color', 'blue')])],
      }),
      cm(),
    )
    const v = verdict(vs, 'color')
    expect(v.winner?.value).toBe('red')
    expect(v.losers).toHaveLength(0)
  })

  it('flags uncertain when the computed value matches a loser instead of the winner', () => {
    const vs = computeCascade(
      payload({
        rules: [ruleMatch('.a', [prop('color', 'blue')]), ruleMatch('.b', [prop('color', 'red')])],
      }),
      cm({ color: 'blue' }), // computed agrees with the predicted LOSER
    )
    const v = verdict(vs, 'color')
    expect(v.winner?.value).toBe('red')
    expect(v.uncertain).toBe(true)
  })

  it('does not flag uncertain for unit-resolved differences', () => {
    const vs = computeCascade(
      payload({ rules: [ruleMatch('.a', [prop('width', '50%')])] }),
      cm({ width: '342px' }), // no other candidate equals 342px → just resolution
    )
    const v = verdict(vs, 'width')
    expect(v.winner?.value).toBe('50%')
    expect(v.computedValue).toBe('342px')
    expect(v.uncertain).toBeUndefined()
  })

  it('attribute style loses to matched rules on specificity', () => {
    const vs = computeCascade(
      payload({
        attributes: style([{ name: 'width', value: '100px' }]),
        rules: [ruleMatch('img', [prop('width', '50px')])],
      }),
      cm({ width: '50px' }),
    )
    const v = verdict(vs, 'width')
    expect(v.winner?.value).toBe('50px')
    expect(v.losers[0]!.decl.originType).toBe('attribute')
    expect(v.losers[0]!.reason).toBe('specificity')
  })

  it('surfaces @media context but ignores link/style media attributes', () => {
    const vs = computeCascade(
      payload({
        rules: [
          ruleMatch('.a', [prop('color', 'red')], {
            media: [
              { text: '(min-width: 768px)', source: 'mediaRule' },
              { text: 'screen', source: 'linkedSheet' },
            ],
          }),
          ruleMatch('.plain', [prop('background-color', 'white')], {
            media: [{ text: 'screen', source: 'linkedSheet' }],
          }),
        ],
      }),
      cm(),
    )
    expect(verdict(vs, 'color').winner?.media).toBe('(min-width: 768px)')
    expect(verdict(vs, 'background-color').winner?.media).toBeUndefined()
  })

  it('opts.properties filters, including the shorthand family', () => {
    const p = payload({
      rules: [ruleMatch('.a', [prop('margin', '10px'), prop('color', 'red')])],
    })
    const onlyBottom = computeCascade(p, cm(), { properties: ['margin-bottom'] })
    expect(onlyBottom.map((v) => v.property)).toEqual(['margin-bottom'])
    // Filtering by the longhand still considers the 'margin' shorthand declaration.
    expect(onlyBottom[0]!.winner?.fromShorthand).toBe('margin')

    const family = computeCascade(p, cm(), { properties: ['margin'] })
    expect(new Set(family.map((v) => v.property))).toEqual(
      new Set(['margin-top', 'margin-right', 'margin-bottom', 'margin-left']),
    )
  })

  it('carries selector, styleSheetId and range through to the verdict', () => {
    const rm = ruleMatch('.hero .btn', [prop('margin-bottom', '24px')])
    const vs = computeCascade(payload({ rules: [rm] }), cm({ 'margin-bottom': '24px' }))
    const w = verdict(vs, 'margin-bottom').winner!
    expect(w.selector).toBe('.hero .btn')
    expect(w.styleSheetId).toBe(rm.rule.styleSheetId)
    expect(w.range).toBeDefined()
    expect(w.specificity).toEqual({ a: 0, b: 2, c: 0 })
  })

  it("an ancestor's inline style beats that ancestor's matched rules at the same distance", () => {
    const vs = computeCascade(
      payload({
        inherited: [
          inheritedEntry(
            [ruleMatch('#parent.very.specific', [prop('color', 'red')])],
            style([prop('color', 'green')]),
          ),
        ],
      }),
      cm({ color: 'green' }),
    )
    const v = verdict(vs, 'color')
    expect(v.winner?.value).toBe('green')
    expect(v.winner?.originType).toBe('inherited-inline')
    expect(v.losers[0]!.reason).toBe('inline')
  })
})
