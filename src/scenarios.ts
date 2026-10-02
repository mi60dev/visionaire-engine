/**
 * Diagnostic scenarios behind the `solve` gateway. Each scenario is a small,
 * explicit PLAN: which engine tools to run, with arguments built from the
 * resolved target and the caller's context — never forwarded blindly (every
 * tool validates its own arg names; see test/solve.test.ts).
 *
 * Routing (keyword-router.ts) matches the caller's sentence against `cues`:
 * weighted regexes over the lowercased intent. Callers can also skip routing
 * by naming `scenario` explicitly.
 */

export type Need = 'element' | 'none'

/** Facts the plan builder can use. `target` is already resolved to {uid}|{selector}|{x,y}. */
export interface PlanInput {
  intent: string
  target?: Record<string, unknown>
  reference?: Record<string, unknown>
  /** Explicit property from context, else one inferred from the intent. */
  property?: string
  viewport?: { width: number; height: number }
  breakpoints?: number[]
  selector?: string
}

export interface PlanStep {
  tool: string
  args: Record<string, unknown>
  /** Optional steps may fail without aborting the plan. */
  optional?: boolean
  /** Pseudo-steps executed by solve itself rather than a ToolDef. */
  kind?: 'tool' | 'viewport' | 'sweep'
}

export interface Scenario {
  id: string
  title: string
  /** Weighted cues; score = sum of weights of matching cues. */
  cues: Array<[RegExp, number]>
  needs: Need
  /** Question asked when `needs: 'element'` and no target was given. */
  ask?: string
  plan: (p: PlanInput) => PlanStep[]
  /** Follow-up the LLM can make next (one line). */
  next: string
}

const t = (p: PlanInput): Record<string, unknown> => p.target ?? {}
const step = (tool: string, args: Record<string, unknown>, optional = false): PlanStep => ({ tool, args, optional })
const viewportStep = (p: PlanInput): PlanStep[] =>
  p.viewport ? [{ tool: 'set_viewport', args: { ...p.viewport }, kind: 'viewport' }] : []

export const SCENARIOS: Scenario[] = [
  {
    id: 'color-wrong',
    title: 'Wrong color — which rule wins the color cascade',
    cues: [
      [/\bcolou?rs?\b/, 3],
      // Bare color words are strong evidence ("why is the link white"), but not inside white-space etc.
      [/(?<![\w-])(red|blue|green|white|black|gr[ae]y|yellow|orange|purple|pink|transparent|hex|rgba?|hsla?)(?![\w-])/, 3],
      [/\b(background|bg|tint|shade|contrast)\b/, 1],
    ],
    needs: 'element',
    ask: 'Which element has the wrong color?',
    plan: (p) => [
      ...viewportStep(p),
      step('explain_styles', { ...t(p), property: p.property ?? 'color' }),
      step('pick_color', { ...t(p) }, true),
    ],
    next: 'test a fix live: solve({tool:"inject_css", args:{uid, declarations:{color:"…"}}}), then edit the WINNER file:line.',
  },
  {
    id: 'style-not-apply',
    title: "Style won't apply — what overrides or disables it",
    cues: [
      [/\b(won'?t|doesn'?t|does not|not|isn'?t|never)\s+(apply|applying|applied|work|working|take effect|taking effect|show)/, 3],
      [/\b(overrid\w*|ignored?|specificity|!important|important|cascade|wins?|beat)\b/, 3],
      [/\b(css|style|rule|declaration|class)\b/, 1],
    ],
    needs: 'element',
    ask: 'Which element is not getting your style (and which property)?',
    plan: (p) => [...viewportStep(p), step('explain_styles', { ...t(p), ...(p.property ? { property: p.property } : {}) })],
    next: 'if the winner is in a file you cannot edit, raise specificity or move your rule later; verify with inject_css first.',
  },
  {
    id: 'what-rule-sets-this',
    title: 'Which rule sets this property (file:line)',
    cues: [
      [/\b(which|what|where)\b.*\b(rule|file|line|stylesheet|css|selector)\b/, 3],
      [/\b(comes? from|set by|sets?|defined|declared)\b/, 2],
    ],
    needs: 'element',
    ask: 'Which element (and which property)?',
    plan: (p) => [step('explain_styles', { ...t(p), ...(p.property ? { property: p.property } : {}) })],
    next: 'edit the WINNER file:line; check blast radius first with solve({tool:"impact_preview", args:{selector}}).',
  },
  {
    id: 'element-wrong-size',
    title: 'Wrong size — measured box and the constraining ancestors',
    cues: [
      [/\b(too\s+(big|small|wide|narrow|tall|short|large)|wrong\s+(size|width|height)|size|width|height|stretch\w*|shrink\w*|squish\w*)\b/, 3],
      [/\b(px|pixels?|dimension|grow|max-width|min-width)\b/, 1],
    ],
    needs: 'element',
    ask: 'Which element has the wrong size?',
    plan: (p) => {
      const concern = /height|tall|short/.test(p.intent) ? 'height' : 'width'
      return [
        ...viewportStep(p),
        step('measure_element', { ...t(p) }),
        step('inspect_ancestors', { ...t(p), concern }),
        step('explain_styles', { ...t(p), property: p.property ?? concern }, true),
      ]
    },
    next: 'the first ancestor line that pins the size is usually the culprit — explain_styles on that uid gives its file:line.',
  },
  {
    id: 'spacing-wrong',
    title: 'Spacing — margin / padding / gap winners',
    cues: [
      [/\b(margin|padding|gap|spacing|space|whitespace|gutter)\b/, 3],
      [/\b(too much|extra|missing|collaps\w*)\b/, 1],
    ],
    needs: 'element',
    ask: 'Which element has the wrong spacing?',
    plan: (p) => [
      ...viewportStep(p),
      step('explain_styles', { ...t(p), property: p.property ?? (/\bgap\b/.test(p.intent) ? 'gap' : /padding/.test(p.intent) ? 'padding' : 'margin') }),
      step('measure_element', { ...t(p) }, true),
    ],
    next: 'collapsing margins and parent padding are common — run with property "padding" on the parent uid if margins look right.',
  },
  {
    id: 'alignment-off',
    title: 'Misaligned / not centered',
    cues: [
      [/\b(align\w*|misalign\w*|cent(er|re)(ed|d)?|off[- ]cent(er|re)|offset|lined? up|line up|justify|vertical(ly)?|horizontal(ly)?)\b/, 3],
      [/\b(not|isn'?t|off)[- ]cent(er|re)(ed|d)?\b/, 2],
    ],
    needs: 'element',
    ask: 'Which element is misaligned?',
    plan: (p) => [
      ...viewportStep(p),
      step('diagnose', { ...t(p), symptom: /cent(er|re)/.test(p.intent) ? 'not_centered' : 'auto' }),
      step('measure_element', { ...t(p) }, true),
      ...(p.selector ? [step('check_alignment', { selector: p.selector }, true)] : []),
    ],
    next: 'for a group of elements pass context.elements as a selector to get alignment clusters (check_alignment).',
  },
  {
    id: 'flex-grid-layout',
    title: 'Flex / grid layout behaving unexpectedly',
    cues: [
      [/\b(flex\w*|grid|columns?|rows?|wrap\w*|order)\b/, 3],
      [/\b(layout|items?|children)\b/, 1],
    ],
    needs: 'element',
    ask: 'Which container (or item) is laid out wrong?',
    plan: (p) => [
      ...viewportStep(p),
      step('inspect_element', { ...t(p) }),
      step('explain_styles', { ...t(p), ...(p.property ? { property: p.property } : {}) }),
      step('inspect_ancestors', { ...t(p), concern: 'width' }, true),
    ],
    next: 'flex/grid props live on the CONTAINER — if the target is an item, re-run on its parent uid.',
  },
  {
    id: 'element-hidden',
    title: 'Hidden / invisible / missing element',
    cues: [
      [/\b(hidden|invisible|not (showing|visible|appearing|displayed|rendering)|disappear\w*|missing|can'?t see|cannot see|gone|blank)\b/, 3],
      [/\b(display|visibility|opacity)\b/, 1],
    ],
    needs: 'element',
    ask: 'Which element should be visible? (selector or text — find it first if unsure)',
    plan: (p) => [...viewportStep(p), step('diagnose', { ...t(p), symptom: 'invisible' }), step('inspect_element', { ...t(p) }, true)],
    next: 'if a coverer is named, solve({tool:"inspect_ancestors", args:{uid, concern:"stacking"}}) shows why z-index loses.',
  },
  {
    id: 'overlap-z-index',
    title: 'Overlap / z-index / stacking order',
    cues: [
      [/\b(overlap\w*|on top|behind|underneath|below|above|covers?|covered|covering|stack\w*|layer\w*|overlay)\b/, 3],
      [/\bz-?index\b/, 4],
      [/\b(behind|underneath|on top of)\b.*\b(overlay|modal|backdrop|header|image|menu)\b/, 2],
    ],
    needs: 'element',
    ask: 'Which element is behind/overlapping (the one that should be on top)?',
    plan: (p) => [
      ...viewportStep(p),
      step('diagnose', { ...t(p), symptom: 'overlapping' }),
      step('inspect_ancestors', { ...t(p), concern: 'stacking' }),
    ],
    next: 'z-index only competes inside the same stacking context — fix the ancestor named in the stacking chain, not the element.',
  },
  {
    id: 'clipped-cutoff',
    title: 'Clipped / cut off / overflowing',
    cues: [
      [/\b(clip\w*|cut ?off|cropped|overflow\w*|spill\w*|scrollbar|sticks? out|bleed\w*)\b/, 3],
    ],
    needs: 'element',
    ask: 'Which element is clipped or overflowing?',
    plan: (p) => [
      ...viewportStep(p),
      step('diagnose', { ...t(p), symptom: /overflow|spill|sticks? out|bleed/.test(p.intent) ? 'overflowing' : 'clipped' }),
      step('inspect_ancestors', { ...t(p), concern: 'overflow' }),
    ],
    next: 'the ancestor with overflow:hidden/clip in the chain is the clipper — change it or the child size.',
  },
  {
    id: 'text-truncated',
    title: 'Text truncated / ellipsis / wrapping',
    cues: [
      [/\b(truncat\w*|ellipsis|\.\.\.|wrap\w*|line ?breaks?|nowrap|text (is )?(cut|hidden))\b/, 3],
      [/\b(text|label|title|heading)\b/, 1],
    ],
    needs: 'element',
    ask: 'Which text element is truncated?',
    plan: (p) => [
      step('measure_element', { ...t(p) }),
      step('explain_styles', { ...t(p), property: p.property ?? 'white-space' }, true),
      step('inspect_ancestors', { ...t(p), concern: 'width' }, true),
    ],
    next: 'compare the ink box with the content box above; the narrowing ancestor is in the width chain.',
  },
  {
    id: 'font-wrong',
    title: 'Wrong font / weight / size / line-height',
    cues: [
      [/\b(font\w*|typeface|bold|weight|italic|serif|sans|typography|line-?height|letter-?spacing|text size)\b/, 3],
    ],
    needs: 'element',
    ask: 'Which text element has the wrong font?',
    plan: (p) => [...viewportStep(p), step('explain_styles', { ...t(p), property: p.property ?? 'font' })],
    next: 'if font-family wins but the glyphs look wrong, the web font may not have loaded — check @font-face in page_origins.',
  },
  {
    id: 'animation-broken',
    title: 'Animation / transition not running or janky',
    cues: [
      [/\b(animat\w*|transition\w*|keyframes?|janky|jank|stutter\w*|smooth|fade\w*|slide\w*|easing|motion)\b/, 3],
    ],
    needs: 'element',
    ask: 'Which element should animate?',
    plan: (p) => [step('explain_animations', { ...t(p), ...(p.property ? { property: p.property } : {}) })],
    next: 'transitions only exist mid-change — trigger it with solve({tool:"record_interaction", args:{uid, action:"hover"}}) to see the timeline.',
  },
  {
    id: 'click-not-working',
    title: 'Click / tap does nothing',
    cues: [
      [/\b(click\w*|tap\w*|press\w*|button does nothing|does nothing|unresponsive|not clickable|can'?t click|handler|listener|onclick|event)\b/, 3],
    ],
    needs: 'element',
    ask: 'Which element should respond to the click?',
    plan: (p) => [step('diagnose', { ...t(p), symptom: 'overlapping' }, true), step('get_listeners', { ...t(p), includeAncestors: true })],
    next: 'to SEE what a click does (DOM changes, handlers, errors): solve({tool:"record_interaction", args:{uid, action:"click"}}) — it really clicks.',
  },
  {
    id: 'hover-state-wrong',
    title: 'Hover / focus state looks wrong',
    cues: [
      [/\b(hover\w*|:hover|mouse ?over|focus\w*|:focus|active state|pressed state)\b/, 4],
    ],
    needs: 'element',
    ask: 'Which element has the wrong hover/focus style?',
    plan: (p) => [
      step('style_diff', { ...t(p), mode: 'record', slot: 'solve-hover' }),
      step('interact', { ...t(p), action: /focus/.test(p.intent) ? 'focus' : 'hover' }),
      step('style_diff', { ...t(p), mode: 'compare', slot: 'solve-hover' }),
      step('explain_styles', { ...t(p), ...(p.property ? { property: p.property } : {}) }, true),
    ],
    next: 'the diff shows exactly which properties the state changes; explain_styles (run while hovered) shows which :hover rule won.',
  },
  {
    id: 'responsive-broken',
    title: 'Breaks at some screen sizes (responsive / media queries)',
    cues: [
      [/\b(mobile|tablet|desktop|responsive|breakpoints?|media ?quer\w*|@media|viewport|screen ?size|small screens?|\d{3,4} ?px)\b/, 3],
      [/\b(breaks?|broken)\b/, 1],
    ],
    needs: 'element',
    ask: 'Which element breaks at which width?',
    plan: (p) => [{ tool: 'responsive', args: { breakpoints: p.breakpoints ?? [375, 768, 1280], property: p.property }, kind: 'sweep' }],
    next: 'set context.viewport to the failing width and re-run with a property to see which @media rule wins there.',
  },
  {
    id: 'positioned-wrong',
    title: 'Positioned element in the wrong place (absolute / fixed / sticky)',
    cues: [
      [/\b(position\w*|absolute|fixed|sticky|relative|top|left|right|bottom|inset|anchor\w*|dropdown|tooltip|popover|placement)\b/, 3],
      [/\b(wrong place|moved|shifted|jumps?)\b/, 1],
    ],
    needs: 'element',
    ask: 'Which positioned element is in the wrong place?',
    plan: (p) => [
      ...viewportStep(p),
      step('inspect_ancestors', { ...t(p), concern: 'position' }),
      step('explain_styles', { ...t(p), property: p.property ?? 'position' }),
      step('measure_element', { ...t(p) }, true),
    ],
    next: 'absolute positions resolve against the nearest positioned ancestor — it is named in the position chain.',
  },
  {
    id: 'find-element',
    title: 'Locate an element on the page',
    cues: [
      [/^\s*(find|show|locate|where('?s| is)|which element|get)\b/, 3],
      [/\b(find|locate|where)\b/, 1],
    ],
    needs: 'none',
    plan: (p) => {
      const text = p.intent
        .replace(/^\s*(please\s+)?(find|show( me)?|locate|where('?s| is)|get|which element is)\s+/i, '')
        .replace(/^(the|a|an)\s+/i, '')
        .replace(/[?.!]+$/, '')
        .replace(/\s+(button|link|element|section|heading|image|icon|input|field)$/i, '')
        .trim()
      return [step('find_elements', p.selector ? { selector: p.selector } : { text: text || p.intent, limit: 10 })]
    },
    next: 'pass the uid you want as context.element in your next solve call.',
  },
  {
    id: 'page-overview',
    title: 'Page overview — element tree with uids',
    cues: [
      [/\b(overview|snapshot|outline|structure|what'?s on|whole page|page tree|dom tree|elements on)\b/, 3],
    ],
    needs: 'none',
    plan: () => [step('page_snapshot', { budgetTokens: 2000 })],
    next: 'target an element by its uid in context.element.',
  },
  {
    id: 'diagnose-issue',
    title: 'General "this looks broken" triage',
    cues: [
      [/\b(broken|wrong|weird|off|bug\w*|glitch\w*|messed up|looks bad|ugly|issue|problem|fix)\b/, 1],
    ],
    needs: 'element',
    ask: 'Which element looks broken?',
    plan: (p) => [...viewportStep(p), step('diagnose', { ...t(p), symptom: 'auto' }), step('inspect_element', { ...t(p) }, true)],
    next: 'name the symptom (hidden / overlap / clipped / size / color) for a focused plan.',
  },
]

export const SCENARIO_IDS = SCENARIOS.map((s) => s.id) as [string, ...string[]]

export function getScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id)
}
