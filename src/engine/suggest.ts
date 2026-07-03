/**
 * Turn a failed selector/text lookup into a helpful, deterministic near-miss list
 * computed from the LIVE DOM — so an agent that guessed a nonexistent id/class gets
 * "did you mean …" plus a nudge to ground itself, instead of a dead end. No LLM.
 */
import type { ToolContext } from '../types.js'

interface DomVocab {
  ids: string[]
  classes: string[]
  total: { ids: number; classes: number }
}

const VOCAB_EXPR = `(() => {
  const ids = new Set(), classes = new Set();
  const els = document.querySelectorAll('*');
  for (const el of els) {
    if (el.id) ids.add(el.id);
    for (const c of el.classList) classes.add(c);
  }
  const cap = (s) => Array.from(s).slice(0, 400);
  return { ids: cap(ids), classes: cap(classes), total: { ids: ids.size, classes: classes.size } };
})()`

async function domVocab(ctx: ToolContext): Promise<DomVocab | undefined> {
  try {
    const { result } = await ctx.cdp.send('Runtime.evaluate', {
      expression: VOCAB_EXPR,
      returnByValue: true,
    })
    const v = result.value as DomVocab | undefined
    if (v && Array.isArray(v.ids) && Array.isArray(v.classes)) return v
  } catch {
    /* suggestion is best-effort — never let it mask the original failure */
  }
  return undefined
}

/** Case-insensitive similarity in [0,1]: substring containment beats edit distance. */
function similarity(a: string, b: string): number {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  if (x === y) return 1
  if (x.includes(y) || y.includes(x)) return 0.85
  const d = editDistance(x, y)
  const max = Math.max(x.length, y.length)
  return max === 0 ? 0 : 1 - d / max
}

function editDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  let curr = new Array<number>(n + 1)
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[n]!
}

function rank(token: string, pool: string[], sigil: string): string[] {
  return pool
    .map((c) => ({ c, s: similarity(token, c) }))
    .filter((x) => x.s >= 0.5)
    .sort((a, b) => b.s - a.s)
    .slice(0, 5)
    .map((x) => sigil + x.c)
}

/** Pull #id and .class tokens out of a CSS selector string. */
function tokensOf(selector: string): { ids: string[]; classes: string[] } {
  const ids = [...selector.matchAll(/#([A-Za-z_][\w-]*)/g)].map((m) => m[1]!)
  const classes = [...selector.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]!)
  return { ids, classes }
}

/**
 * Build a one-paragraph help string for a selector that matched nothing.
 * Suggests the closest ids/classes that DO exist, and points at the grounding tools.
 */
export async function selectorHelp(ctx: ToolContext, selector: string): Promise<string> {
  const vocab = await domVocab(ctx)
  const ground =
    'Ground the selector first: take a page_snapshot for the real uid-keyed tree, or read the ' +
    "project source you're running in for the actual class/id names — then target by uid."
  if (!vocab) return ground
  const { ids, classes } = tokensOf(selector)
  const suggestions = [
    ...ids.flatMap((t) => rank(t, vocab.ids, '#')),
    ...classes.flatMap((t) => rank(t, vocab.classes, '.')),
  ]
  const uniq = [...new Set(suggestions)].slice(0, 6)
  const census = `(page has ${vocab.total.ids} ids, ${vocab.total.classes} class names)`
  if (uniq.length > 0) return `Did you mean: ${uniq.join(', ')} ${census}? ${ground}`
  return `No close match among the page's selectors ${census}. ${ground}`
}
