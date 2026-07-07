/**
 * impact — pure grouping logic for impact_preview (v-next SPEC §3D).
 * Given per-element facts for every match of a shared selector, produce a
 * deterministic blast-radius grouping so an agent can see WHAT ELSE an edit
 * would touch before touching it. Zod-free, browser-free, unit-testable.
 *
 * Region rule (deterministic, documented): an element's document center-y
 * (rect.y + rect.height / 2) buckets into
 *   'top'    when center-y <  25% of pageHeight,
 *   'bottom' when center-y >= 75% of pageHeight,
 *   'middle' otherwise.
 * Items without a rect (display:none / detached) bucket as 'unpositioned'.
 * A non-positive pageHeight buckets every positioned item as 'top'.
 */
import type { Bounds } from '../types.js'

export type ImpactGroupBy = 'visual_role' | 'region' | 'tag'

export interface ImpactItem {
  uid: string
  tag: string
  classes: string[]
  /** Explicit role="" attribute — wins over the implied role. */
  role?: string
  attrId?: string
  /** For <input>: the type attribute (lowercased); drives textbox vs checkbox implication. */
  inputType?: string
  /** Border box in DOCUMENT CSS px; absent for non-rendered elements. */
  rect?: Bounds
  /** Short human identity, e.g. "<a#home.nav-item>". */
  identity: string
}

export interface ImpactGroup {
  key: string
  count: number
  uids: string[]
  /** Region(s) the group spans, canonical order, comma-joined (single for visual_role/region grouping). */
  region: string
  sample_identity: string
}

const REGION_ORDER = ['top', 'middle', 'bottom', 'unpositioned'] as const

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

/**
 * Implied ARIA role for common tags (grouping heuristic only, not a full
 * accName computation): a→link, button→button, nav→navigation, h1-h6→heading,
 * input→checkbox when type=checkbox else textbox, footer→contentinfo,
 * header→banner.
 */
export function impliedRole(tag: string, inputType?: string): string | undefined {
  const t = tag.toLowerCase()
  if (t === 'a') return 'link'
  if (t === 'button') return 'button'
  if (t === 'nav') return 'navigation'
  if (HEADING_TAGS.has(t)) return 'heading'
  if (t === 'footer') return 'contentinfo'
  if (t === 'header') return 'banner'
  if (t === 'input') return (inputType ?? 'text').toLowerCase() === 'checkbox' ? 'checkbox' : 'textbox'
  return undefined
}

/** Deterministic screen-region bucket for a document-px rect — rule documented in the module header. */
export function regionOf(rect: Bounds | undefined, pageHeight: number): string {
  if (!rect) return 'unpositioned'
  if (pageHeight <= 0) return 'top'
  const centerY = rect.y + rect.height / 2
  if (centerY < pageHeight * 0.25) return 'top'
  if (centerY >= pageHeight * 0.75) return 'bottom'
  return 'middle'
}

/** visual_role key: '<tag>[.<up-to-2-sorted-classes>]@<region>[role=X]'. */
function visualRoleKey(item: ImpactItem, region: string): string {
  const cls = [...item.classes]
    .sort()
    .slice(0, 2)
    .map((c) => `.${c}`)
    .join('')
  const role = item.role ?? impliedRole(item.tag, item.inputType)
  return `${item.tag.toLowerCase()}${cls}@${region}${role ? `[role=${role}]` : ''}`
}

/**
 * Group matched elements deterministically: same input, same output. Groups
 * are sorted by count descending, then key ascending; uids keep input order.
 */
export function groupImpact(items: ImpactItem[], groupBy: ImpactGroupBy, pageHeight: number): ImpactGroup[] {
  interface Acc {
    key: string
    count: number
    uids: string[]
    regions: Set<string>
    sample_identity: string
  }
  const byKey = new Map<string, Acc>()
  for (const item of items) {
    const region = regionOf(item.rect, pageHeight)
    const key =
      groupBy === 'tag' ? item.tag.toLowerCase() : groupBy === 'region' ? region : visualRoleKey(item, region)
    let acc = byKey.get(key)
    if (!acc) {
      acc = { key, count: 0, uids: [], regions: new Set(), sample_identity: item.identity }
      byKey.set(key, acc)
    }
    acc.count++
    acc.uids.push(item.uid)
    acc.regions.add(region)
  }
  const groups: ImpactGroup[] = [...byKey.values()].map((acc) => ({
    key: acc.key,
    count: acc.count,
    uids: acc.uids,
    region: REGION_ORDER.filter((r) => acc.regions.has(r)).join(','),
    sample_identity: acc.sample_identity,
  }))
  groups.sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return groups
}
