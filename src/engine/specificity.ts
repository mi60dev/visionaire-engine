/**
 * Selector specificity — SPEC §6.1 step 3 fallback when CDP's experimental
 * per-selector `specificity` field is absent.
 *
 * Counts ids (a), classes/attributes/pseudo-classes (b), types/pseudo-elements (c).
 * :not()/:is()/:has() take the max specificity of their argument list; :where() is
 * zero. Universal selector, combinators and the nesting selector (&) count nothing.
 */
import type { Specificity } from '../types.js'

/** Pseudo-classes whose specificity is the max of their selector-list argument. */
const MAX_ARG_PSEUDOS = new Set(['not', 'is', 'has', 'matches', 'any', '-webkit-any', '-moz-any'])

/** Single-colon pseudo-elements grandfathered from CSS2. */
const LEGACY_PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter'])

export function computeSpecificity(selector: string): Specificity {
  return maxOfList(selector)
}

/** Standard (a, b, c) lexicographic compare; >0 when a is more specific. */
export function compareSpecificity(a: Specificity, b: Specificity): number {
  return a.a - b.a || a.b - b.b || a.c - b.c
}

/** A selector list's specificity is the max over its comma-separated members. */
function maxOfList(list: string): Specificity {
  let best: Specificity = { a: 0, b: 0, c: 0 }
  for (const part of splitTopLevel(list, ',')) {
    const s = complexSpecificity(part)
    if (compareSpecificity(s, best) > 0) best = s
  }
  return best
}

function complexSpecificity(sel: string): Specificity {
  let a = 0
  let b = 0
  let c = 0
  let i = 0
  const n = sel.length

  while (i < n) {
    const ch = sel[i]!

    if (ch === '[') {
      i = skipBalanced(sel, i, '[', ']')
      b++
      continue
    }
    if (ch === '.') {
      i = skipIdent(sel, i + 1)
      b++
      continue
    }
    if (ch === '#') {
      i = skipIdent(sel, i + 1)
      a++
      continue
    }
    if (ch === '*') {
      i++
      // '*|' — universal with namespace prefix; skip the separator too.
      if (sel[i] === '|' && sel[i + 1] !== '|' && sel[i + 1] !== '=') i++
      continue
    }
    if (ch === ':') {
      let isElementSyntax = false
      i++
      if (sel[i] === ':') {
        isElementSyntax = true
        i++
      }
      const nameStart = i
      i = skipIdent(sel, i)
      const name = sel.slice(nameStart, i).toLowerCase()
      let arg: string | undefined
      if (sel[i] === '(') {
        const end = skipBalanced(sel, i, '(', ')')
        arg = sel.slice(i + 1, end - 1)
        i = end
      }
      if (isElementSyntax || LEGACY_PSEUDO_ELEMENTS.has(name)) {
        c++
        continue
      }
      if (name === 'where') continue
      if (MAX_ARG_PSEUDOS.has(name)) {
        if (arg !== undefined) {
          const m = maxOfList(arg)
          a += m.a
          b += m.b
          c += m.c
        }
        continue
      }
      if ((name === 'host' || name === 'host-context') && arg !== undefined) {
        // :host(S) counts the pseudo-class plus S's specificity.
        const m = maxOfList(arg)
        a += m.a
        b += m.b + 1
        c += m.c
        continue
      }
      // Any other pseudo-class (incl. functional ones like :nth-child(2n)).
      // Note: the `of S` clause of :nth-child(An+B of S) is not added — exotic.
      b++
      continue
    }
    if (isIdentStart(ch)) {
      i = skipIdent(sel, i)
      if (sel[i] === '|' && sel[i + 1] !== '|' && sel[i + 1] !== '=') {
        // 'ns|type' — what we consumed was a namespace prefix, not a type selector.
        i++
        if (sel[i] === '*') i++
        continue
      }
      c++
      continue
    }
    // Combinators, whitespace, '&', stray characters.
    i++
  }
  return { a, b, c }
}

function isIdentStart(ch: string): boolean {
  return /[a-zA-Z_-]/.test(ch) || ch === '\\' || ch >= ''
}

function skipIdent(s: string, i: number): number {
  const n = s.length
  while (i < n) {
    const ch = s[i]!
    if (ch === '\\' && i + 1 < n) {
      i += 2
      continue
    }
    if (/[-\w]/.test(ch) || ch >= '') {
      i++
      continue
    }
    break
  }
  return i
}

/** From an opening bracket, return the index just past its balanced close. Quote- and escape-aware. */
function skipBalanced(s: string, openIdx: number, open: string, close: string): number {
  let depth = 0
  let i = openIdx
  const n = s.length
  while (i < n) {
    const ch = s[i]!
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '"' || ch === "'") {
      i = skipString(s, i)
      continue
    }
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return i + 1
    }
    i++
  }
  return n
}

function skipString(s: string, quoteIdx: number): number {
  const quote = s[quoteIdx]!
  let i = quoteIdx + 1
  const n = s.length
  while (i < n) {
    const ch = s[i]!
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === quote) return i + 1
    i++
  }
  return n
}

/** Split on a separator at paren/bracket depth 0, outside strings. */
function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  let i = 0
  const n = s.length
  while (i < n) {
    const ch = s[i]!
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '"' || ch === "'") {
      i = skipString(s, i)
      continue
    }
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (ch === sep && depth === 0) {
      parts.push(s.slice(start, i))
      start = i + 1
    }
    i++
  }
  parts.push(s.slice(start))
  return parts
}
