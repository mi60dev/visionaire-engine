/**
 * Deterministic intent router for `solve` — offline, no model, no network.
 *
 * Each scenario carries weighted regex cues (scenarios.ts); a query's score for a
 * scenario is the sum of the weights of the cues it matches. The router reports
 * the ranked candidates so solve can act on a clear winner and otherwise SHOW the
 * candidates instead of guessing (an agent can then pass `scenario` explicitly).
 */
import { SCENARIOS, type Scenario } from './scenarios.js'

export interface RouteCandidate {
  scenario: Scenario
  score: number
}

export interface RouteResult {
  /** Best candidate, or undefined when nothing matched at all. */
  best?: RouteCandidate
  /** Top candidates, best first (max 4). */
  candidates: RouteCandidate[]
  /** True when the best candidate clearly beats the runner-up. */
  confident: boolean
}

/** CSS properties we can lift straight out of a sentence ("why is the padding-top 40px"). */
const PROPERTY_WORDS: Array<[RegExp, string]> = [
  [/\bbackground(-colou?r)?\b|\bbg\b/, 'background-color'],
  [/\bborder(-colou?r)?\b/, 'border'],
  [/\b(text )?colou?r\b/, 'color'],
  [/\bfont[- ]?size\b|\btext size\b/, 'font-size'],
  [/\bfont[- ]?weight\b|\bbold\b/, 'font-weight'],
  [/\bfont[- ]?family\b|\btypeface\b/, 'font-family'],
  [/\bline[- ]?height\b/, 'line-height'],
  [/\bletter[- ]?spacing\b/, 'letter-spacing'],
  [/\bz-?index\b/, 'z-index'],
  [/\bopacity\b/, 'opacity'],
  [/\bpadding(-(top|right|bottom|left))?\b/, 'padding'],
  [/\bmargin(-(top|right|bottom|left))?\b/, 'margin'],
  [/\bgap\b/, 'gap'],
  [/\bmax-width\b/, 'max-width'],
  [/\bmin-width\b/, 'min-width'],
  [/\bwidth\b/, 'width'],
  [/\bheight\b/, 'height'],
  [/\bjustify-content\b/, 'justify-content'],
  [/\balign-items\b/, 'align-items'],
  [/\bdisplay\b/, 'display'],
  [/\bposition\b/, 'position'],
  [/\boverflow\b/, 'overflow'],
  [/\btransform\b/, 'transform'],
  [/\bbox-shadow\b|\bshadow\b/, 'box-shadow'],
  [/\bborder-radius\b|\brounded\b|\bradius\b/, 'border-radius'],
  [/\btext-align\b/, 'text-align'],
  [/\bwhite-space\b/, 'white-space'],
]

/** Explicit `prop: value` / `prop` tokens win; otherwise the first property word in the sentence. */
export function inferProperty(intent: string): string | undefined {
  const q = intent.toLowerCase()
  const explicit = /\b([a-z]+(?:-[a-z]+)+)\s*:/.exec(q)
  if (explicit) return explicit[1]
  let best: { at: number; prop: string } | undefined
  for (const [re, prop] of PROPERTY_WORDS) {
    const m = re.exec(q)
    if (m && (!best || m.index < best.at)) best = { at: m.index, prop }
  }
  return best?.prop
}

export function routeQuery(intent: string): RouteResult {
  const q = ` ${String(intent ?? '').toLowerCase().replace(/\s+/g, ' ')} `
  const scored: RouteCandidate[] = []
  for (const scenario of SCENARIOS) {
    let score = 0
    for (const [re, weight] of scenario.cues) if (re.test(q)) score += weight
    if (score > 0) scored.push({ scenario, score })
  }
  // Stable: ties keep SCENARIOS order (specific scenarios are listed before generic ones).
  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]
  const second = scored[1]
  const confident = !!best && best.score >= 3 && (!second || best.score - second.score >= 1)
  return { best, candidates: scored.slice(0, 4), confident }
}
