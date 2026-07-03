/**
 * Blast radius + scoped-fix suggestion — the "change THE button, not all buttons" engine.
 *
 * Knowing the winning rule's file:line is not enough to edit safely: the same rule
 * may style dozens of other elements. This module reports, deterministically,
 * (a) how many OTHER elements each winning selector matches on the live page, and
 * (b) a selector that uniquely targets the inspected element, with a specificity
 * comparison against the winner so the calling LLM knows the fix shape.
 */
import type { Specificity, ToolContext } from '../types.js'
import { sanitizePageText } from '../types.js'
import { computeSpecificity, compareSpecificity } from './specificity.js'

export interface SelectorReach {
  selector: string
  /** Total elements the selector matches on this page (including the inspected one). */
  count: number
  /** Up to 2 identity strings for OTHER matched elements, e.g. "<button.save>". */
  samples: string[]
}

export interface ScopeData {
  reaches: SelectorReach[]
  /** A selector matching ONLY the inspected element, or null when none was found. */
  uniqueSelector: string | null
}

/**
 * One in-page pass: for each winner selector, count matches + sample other matches;
 * and derive a unique selector for `this` element (id → tag.classes → ancestor#id
 * scoping → nth-of-type path). Selectors that fail to parse are skipped silently.
 */
const SCOPE_FN = `function (selectorsJson) {
  const selectors = JSON.parse(selectorsJson);
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);
  const identity = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = Array.prototype.slice.call(el.classList, 0, 2).map((c) => '.' + c).join('');
    return '<' + el.tagName.toLowerCase() + id + cls + '>';
  };
  const reaches = [];
  for (const sel of selectors) {
    try {
      const all = Array.prototype.slice.call(document.querySelectorAll(sel));
      const others = all.filter((x) => x !== this).slice(0, 2).map(identity);
      reaches.push({ selector: sel, count: all.length, samples: others });
    } catch (e) { /* unparseable in querySelectorAll (e.g. UA-internal) — skip */ }
  }
  const unique = (() => {
    const el = this;
    const matchesOnly = (s) => { try { const m = document.querySelectorAll(s); return m.length === 1 && m[0] === el; } catch (e) { return false; } };
    if (el.id && matchesOnly('#' + esc(el.id))) return '#' + esc(el.id);
    const cls = Array.prototype.slice.call(el.classList, 0, 3).map((c) => '.' + esc(c)).join('');
    const tagCls = el.tagName.toLowerCase() + cls;
    if (cls && matchesOnly(tagCls)) return tagCls;
    let a = el.parentElement;
    while (a && a !== document.documentElement) {
      if (a.id) {
        const s = '#' + esc(a.id) + ' ' + tagCls;
        if (matchesOnly(s)) return s;
      }
      a = a.parentElement;
    }
    const path = [];
    let n = el;
    for (let i = 0; i < 4 && n && n.nodeType === 1 && n !== document.body; i++) {
      const parent = n.parentElement;
      if (!parent) break;
      const sameTag = Array.prototype.filter.call(parent.children, (c) => c.tagName === n.tagName);
      path.unshift(n.tagName.toLowerCase() + ':nth-of-type(' + (sameTag.indexOf(n) + 1) + ')');
      const s = path.join(' > ');
      if (matchesOnly(s)) return s;
      n = parent;
    }
    return null;
  })();
  return JSON.stringify({ reaches: reaches, uniqueSelector: unique });
}`

export async function collectScopeData(
  ctx: ToolContext,
  backendNodeId: number,
  selectors: string[],
): Promise<ScopeData | undefined> {
  if (selectors.length === 0) return undefined
  try {
    const { object } = await ctx.cdp.send('DOM.resolveNode', { backendNodeId })
    if (!object.objectId) return undefined
    const res = await ctx.cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: SCOPE_FN,
      arguments: [{ value: JSON.stringify(selectors) }],
      returnByValue: true,
    })
    if (typeof res.result.value !== 'string') return undefined
    const parsed = JSON.parse(res.result.value) as ScopeData
    parsed.reaches = parsed.reaches.map((r) => ({
      ...r,
      samples: r.samples.map((s) => sanitizePageText(s, 60)),
    }))
    if (parsed.uniqueSelector) parsed.uniqueSelector = sanitizePageText(parsed.uniqueSelector, 120)
    return parsed
  } catch {
    return undefined // scope info is additive — never let it break the dossier
  }
}

function specOf(selector: string, known?: Specificity): Specificity {
  return known ?? computeSpecificity(selector)
}

function fmt(s: Specificity): string {
  return `spec(${s.a},${s.b},${s.c})`
}

/**
 * Pure phrasing over the collected data — unit-testable.
 * winnerSpecs: selector → specificity when CDP already provided it.
 */
export function buildScopeNotes(
  data: ScopeData,
  winnerSpecs: Map<string, Specificity | undefined>,
): string[] {
  const notes: string[] = []
  const broad = data.reaches.filter((r) => r.count > 1)
  for (const r of broad.slice(0, 4)) {
    const sample = r.samples.length ? ` (e.g. ${r.samples.join(', ')})` : ''
    notes.push(
      `⚠ blast radius: winner '${r.selector}' also styles ${r.count - 1} other element${r.count - 1 === 1 ? '' : 's'} on this page${sample} — editing that rule changes them all`,
    )
  }
  if (broad.length > 0 && data.uniqueSelector) {
    const sug = computeSpecificity(data.uniqueSelector)
    const strongest = broad
      .map((r) => specOf(r.selector, winnerSpecs.get(r.selector)))
      .reduce((a, b) => (compareSpecificity(a, b) >= 0 ? a : b))
    const beats = compareSpecificity(sug, strongest) > 0
    notes.push(
      beats
        ? `to change ONLY this element: use '${data.uniqueSelector}' — matches 1 element, ${fmt(sug)} beats winner ${fmt(strongest)}`
        : `to change ONLY this element: use '${data.uniqueSelector}' (matches 1 element) — but its ${fmt(sug)} does NOT beat winner ${fmt(strongest)}; place it later in the same sheet, raise specificity, or use !important`,
    )
  }
  return notes
}
