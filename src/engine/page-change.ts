/**
 * Page-level state before/after an interaction (field report 2026-10-06: after a click
 * on a dialog's Cancel button, interact reported only the button — the agent could not
 * tell whether the dialog had closed). A small, deterministic probe: URL, title, open
 * dialogs, focused element, element count, scroll — and a pure diff in words.
 */
import type { ToolContext } from '../types.js'

export interface PageState {
  url: string
  title: string
  /** Visible dialogs (dialog[open], role=dialog/alertdialog, aria-modal) by accessible label. */
  dialogs: string[]
  /** Focused element as `tag#id "label"`, or null when nothing (body) has focus. */
  focus: string | null
  /** document.getElementsByTagName('*').length */
  nodes: number
  scrollY: number
}

export const PAGE_STATE_EXPRESSION = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' };
  const label = (d) => (d.getAttribute('aria-label') || d.querySelector('h1,h2,h3,h4,[role=heading]')?.textContent || d.id || d.tagName.toLowerCase())
    .trim().replace(/\\s+/g, ' ').slice(0, 60);
  const dialogs = [...document.querySelectorAll('dialog[open],[role=dialog],[role=alertdialog],[aria-modal="true"]')].filter(vis).map(label);
  const a = document.activeElement;
  const focus = a && a !== document.body && a !== document.documentElement
    ? a.tagName.toLowerCase() + (a.id ? '#' + a.id : '') + (a.getAttribute('aria-label') ? ' "' + a.getAttribute('aria-label').slice(0, 40) + '"' : '')
    : null;
  return { url: location.href, title: document.title, dialogs: [...new Set(dialogs)], focus,
    nodes: document.getElementsByTagName('*').length, scrollY: Math.round(scrollY) };
})()`

export async function readPageState(ctx: ToolContext): Promise<PageState | undefined> {
  try {
    const r = await ctx.cdp.send('Runtime.evaluate', { expression: PAGE_STATE_EXPRESSION, returnByValue: true })
    if (r.exceptionDetails) return undefined
    return r.result.value as PageState
  } catch {
    // A click that navigates can destroy the context mid-probe — report what we can.
    return undefined
  }
}

/** Pure: what changed on the page, one clause per change. Empty when nothing observable changed. */
export function describePageChange(before: PageState, after: PageState): string[] {
  const out: string[] = []
  if (before.url !== after.url) out.push(`URL changed: ${before.url} → ${after.url}`)
  else if (before.title !== after.title) out.push(`title changed: "${before.title}" → "${after.title}"`)
  const opened = after.dialogs.filter((d) => !before.dialogs.includes(d))
  const closed = before.dialogs.filter((d) => !after.dialogs.includes(d))
  for (const d of opened) out.push(`dialog opened: "${d}"`)
  for (const d of closed) out.push(`dialog closed: "${d}"`)
  if (before.focus !== after.focus) out.push(`focus: ${before.focus ?? 'none'} → ${after.focus ?? 'none'}`)
  const delta = after.nodes - before.nodes
  if (delta !== 0) out.push(`${Math.abs(delta)} element${Math.abs(delta) === 1 ? '' : 's'} ${delta > 0 ? 'added' : 'removed'}`)
  if (before.scrollY !== after.scrollY) out.push(`page scrolled ${before.scrollY} → ${after.scrollY}px`)
  return out
}
