/**
 * Pure merge/coalesce/render half of record_interaction — SPEC §14.4.
 * No CDP here: buildTimeline() turns raw TimelineEvents into a chronological,
 * coalesced, capped timeline (and rewrites started→cancelled animation pairs
 * into the explicit CANCELLED verdict); renderTimeline() produces the §14.4
 * text format. Both are unit-testable without a browser.
 */
import type { ResolvedScriptPos, TimelineEvent, TimelineEventKind } from '../types.js'

// ───────────────────────── coalescing tables ─────────────────────────

/** Kinds that may collapse into "+N similar …" lines. */
const COALESCIBLE: ReadonlySet<TimelineEventKind> = new Set([
  'attribute-change',
  'node-inserted',
  'node-removed',
  'text-change',
  'layout-shift',
] satisfies TimelineEventKind[])

const KIND_LABEL: Partial<Record<TimelineEventKind, string>> = {
  'attribute-change': 'attribute changes',
  'node-inserted': 'node insertions',
  'node-removed': 'node removals',
  'text-change': 'text changes',
  'layout-shift': 'layout shifts',
}

/** Insert/remove events carry the PARENT uid — "+N similar node insertions under e12". */
const UNDER_KINDS: ReadonlySet<TimelineEventKind> = new Set([
  'node-inserted',
  'node-removed',
] satisfies TimelineEventKind[])

/** Runs longer than this collapse (first event kept, rest coalesced). */
const MAX_RUN = 3

// ───────────────────────── animation pair detection ─────────────────────────

interface AnimRef {
  word: string
  uid: string
  property: string
}

/** Matches the tool's "transition started on e12: width 300ms ease" summaries. */
function parseStarted(summary: string): AnimRef | undefined {
  const m = /^(transition|animation) started on (\S+): (\S+)/.exec(summary)
  return m ? { word: m[1]!, uid: m[2]!, property: m[3]! } : undefined
}

/** Matches the tool's "transition cancelled on e12 (width)" summaries. */
function parseCancelled(summary: string): AnimRef | undefined {
  const m = /^(transition|animation) cancelled on (\S+) \(([^)]+)\)/.exec(summary)
  return m ? { word: m[1]!, uid: m[2]!, property: m[3]! } : undefined
}

// ───────────────────────── buildTimeline ─────────────────────────

/**
 * Sort by tMs (arrival order breaks ties — CDP DOM events carry no timestamps,
 * so input order is authoritative), rewrite started→cancelled pairs into the
 * SPEC verdict, coalesce runs of >MAX_RUN similar events, cap at maxEvents
 * with a truncation marker. Pure: the input array and its events are not mutated.
 */
export function buildTimeline(raw: TimelineEvent[], opts: { maxEvents: number }): TimelineEvent[] {
  const maxEvents = Math.max(2, Math.floor(opts.maxEvents))
  const events = raw.map((e) => ({ ...e }))
  // Array.prototype.sort is stable (ES2019) — equal tMs keeps arrival order.
  events.sort((a, b) => (a.tMs ?? 0) - (b.tMs ?? 0))

  // started→cancelled verdict: same uid + same property within the window.
  const started = new Set<string>()
  for (const ev of events) {
    if (ev.kind !== 'animation-started') continue
    const ref = parseStarted(ev.summary)
    if (ref) started.add(`${ref.uid}|${ref.property}`)
  }
  for (const ev of events) {
    if (ev.kind !== 'animation-cancelled') continue
    const ref = parseCancelled(ev.summary)
    if (ref && started.has(`${ref.uid}|${ref.property}`)) {
      ev.summary =
        `✗ ${ref.word} CANCELLED on ${ref.uid} (${ref.property}) — ` +
        'a style/display change removed it mid-flight. That is the jump.'
    }
  }

  // Coalesce runs of similar events (same kind + same owning uid).
  const key = (ev: TimelineEvent): string | undefined =>
    COALESCIBLE.has(ev.kind) ? `${ev.kind}|${ev.uid ?? ''}` : undefined
  const coalesced: TimelineEvent[] = []
  for (let i = 0; i < events.length; ) {
    const head = events[i]!
    const k = key(head)
    let j = i + 1
    while (k !== undefined && j < events.length && key(events[j]!) === k) j++
    const run = j - i
    if (k !== undefined && run > MAX_RUN) {
      coalesced.push(head)
      const rest = run - 1
      const prep = UNDER_KINDS.has(head.kind) ? 'under' : 'on'
      const where = head.uid ? ` ${prep} ${head.uid}` : ''
      coalesced.push({
        kind: 'coalesced',
        tMs: events[i + 1]!.tMs,
        uid: head.uid,
        count: rest,
        summary: `+${rest} similar ${KIND_LABEL[head.kind] ?? 'events'}${where}`,
      })
    } else {
      for (let n = i; n < j; n++) coalesced.push(events[n]!)
    }
    i = j
  }

  // Hard cap with a truncation marker.
  if (coalesced.length > maxEvents) {
    const kept = coalesced.slice(0, maxEvents - 1)
    const dropped = coalesced.length - kept.length
    kept.push({
      kind: 'coalesced',
      tMs: coalesced[maxEvents - 1]!.tMs,
      count: dropped,
      summary: `[${dropped} more events truncated — raise maxEvents to see them]`,
    })
    return kept
  }
  return coalesced
}

// ───────────────────────── renderTimeline ─────────────────────────

/** "http://host/js/sidebar.js" → "js/sidebar.js" (last two path segments). */
export function shortUrl(url: string): string {
  try {
    const u = new URL(url)
    const segs = u.pathname.split('/').filter(Boolean)
    if (segs.length === 0) return u.hostname || url
    return segs.slice(-2).join('/')
  } catch {
    return url
  }
}

function locationOf(pos: ResolvedScriptPos): string {
  if (pos.authored) return `${pos.authored.file}:${pos.authored.line}`
  return `${shortUrl(pos.url)}:${pos.line}`
}

function tColumn(tMs: number | undefined): string {
  const label = tMs === undefined ? 't=?' : Math.round(tMs) <= 0 ? 't=0' : `t=${Math.round(tMs)}ms`
  return label.length >= 8 ? `${label} ` : label.padEnd(8, ' ')
}

/**
 * SPEC §14.4 output format: t=Nms columns, "→ handler fn @ file:line [origin]"
 * source suffixes, "(attribution note)" parentheticals. Summaries arrive
 * fully formed (including the ✗ CANCELLED verdict rewritten by buildTimeline).
 */
export function renderTimeline(header: string, events: TimelineEvent[]): string {
  const lines = [header]
  for (const ev of events) {
    let line = tColumn(ev.tMs) + ev.summary
    if (ev.source) {
      const handlerWord = ev.kind === 'action' || ev.kind === 'handler' ? 'handler ' : ''
      const fn = ev.source.functionName ? `${ev.source.functionName} ` : ''
      line += ` → ${handlerWord}${fn}@ ${locationOf(ev.source)}`
      if (ev.source.originLabel) line += `  [${ev.source.originLabel}]`
    }
    if (ev.attributionNote) line += `  (${ev.attributionNote})`
    lines.push(line)
  }
  return lines.join('\n')
}
