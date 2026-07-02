/**
 * Census renderer — SPEC §8.1. Plain-text nested page tree, token-budgeted.
 * Pruning order (SPEC §4): invisible subtrees → wrapper-chain collapse → deepest-level truncation.
 */
import type { PageMeta, PlatformInfo, SnapshotNode } from '../types.js'
import { estimateTokens } from '../types.js'

/** Mutable working tree so pruning never touches the caller's SnapshotNodes. */
interface Work {
  n: SnapshotNode
  children: Work[]
  /** Direct invisible children collapsed into one bracket line. */
  invisible: SnapshotNode[]
  /** Nodes pruned beneath this node (whole removed subtrees). */
  pruned: number
  /** Tags of directly removed children — enables the "[5 links]" marker. */
  prunedTags: string[]
}

function toWork(n: SnapshotNode, inlineInvisible: boolean): Work {
  const w: Work = { n, children: [], invisible: [], pruned: n.prunedChildren ?? 0, prunedTags: [] }
  for (const c of n.children) {
    if (c.visible || inlineInvisible) w.children.push(toWork(c, inlineInvisible))
    else w.invisible.push(c)
  }
  return w
}

/** Prune step 1 (includeInvisible mode): demote inline invisible nodes back to bracket entries. */
function demoteInvisible(w: Work): void {
  const keep: Work[] = []
  for (const c of w.children) {
    if (c.n.visible) {
      demoteInvisible(c)
      keep.push(c)
    } else {
      w.invisible.push(c.n)
    }
  }
  w.children = keep
}

function isWrapper(w: Work): boolean {
  return (
    (w.n.tag === 'div' || w.n.tag === 'span') &&
    w.n.visible &&
    !w.n.attrId &&
    w.n.classes.length <= 1 &&
    !w.n.layout &&
    !w.n.text &&
    w.children.length === 1 &&
    w.invisible.length === 0
  )
}

/** Prune step 2: splice out single-child wrapper chains. Returns nodes removed. */
function collapseWrappers(w: Work): number {
  let count = 0
  for (let i = 0; i < w.children.length; i++) {
    let c = w.children[i]!
    while (isWrapper(c)) {
      const only = c.children[0]!
      only.pruned += c.pruned
      only.prunedTags.push(...c.prunedTags)
      w.children[i] = only
      c = only
      count++
    }
    count += collapseWrappers(c)
  }
  return count
}

function maxDepth(w: Work): number {
  let d = 0
  for (const c of w.children) d = Math.max(d, 1 + maxDepth(c))
  return d
}

/** Prune step 3: remove all nodes at relative depth d (always the current leaf level). */
function removeAtDepth(w: Work, d: number): number {
  let removed = 0
  if (d === 1) {
    for (const c of w.children) {
      const n = 1 + c.pruned + c.invisible.length
      removed += n
      w.pruned += n
      w.prunedTags.push(c.n.tag)
    }
    w.children = []
  } else {
    for (const c of w.children) removed += removeAtDepth(c, d - 1)
  }
  return removed
}

function identity(n: SnapshotNode): string {
  let s = n.tag
  if (n.attrId) s += `#${n.attrId}`
  for (const c of n.classes.slice(0, 3)) s += `.${c}`
  return s
}

function nodeLine(w: Work, depth: number, isRoot: boolean): string {
  const n = w.n
  let s = `${'  '.repeat(depth)}${n.uid} ${identity(n)}`
  if (n.text) s += ` "${n.text}"`
  if (n.bounds) {
    s += ` ${Math.round(n.bounds.width)}x${Math.round(n.bounds.height)}`
    if (!isRoot) s += ` @(${Math.round(n.bounds.x)},${Math.round(n.bounds.y)})`
  }
  if (n.layout) s += ` ${n.layout}`
  if (!n.visible && n.invisibleReason) s += ` [${n.invisibleReason}]`
  if (w.pruned > 0) {
    const allLinks = w.prunedTags.length === w.pruned && w.prunedTags.every((t) => t === 'a')
    s += allLinks ? ` [${w.pruned} links]` : ` [${w.pruned} pruned]`
  }
  return s
}

function invisibleLine(list: SnapshotNode[], depth: number, detail: boolean): string {
  const noun = list.length === 1 ? 'invisible node' : 'invisible nodes'
  const base = `${'  '.repeat(depth)}[${list.length} ${noun} hidden`
  if (!detail) return `${base}]`
  return `${base}: ${list.map((c) => `${c.uid}(${c.invisibleReason ?? 'hidden'})`).join(' ')}]`
}

function platformSummary(p: PlatformInfo): string {
  const parts: string[] = []
  if (p.platform === 'wordpress') parts.push(`WordPress${p.version ? ` ${p.version}` : ''}`)
  if (p.theme) parts.push(`theme ${p.theme}${p.childTheme ? ` (child: ${p.childTheme})` : ''}`)
  if (p.builders.length > 0) parts.push(`builder ${p.builders.join('+')}`)
  if (p.optimizers.length > 0) parts.push(`optimizer ${p.optimizers.join('+')}`)
  return parts.join(', ')
}

function headerLine(page: PageMeta): string {
  let s = `page: ${page.url} "${page.title}"  viewport ${page.viewport.width}x${page.viewport.height}`
  if (page.platform) {
    const summary = platformSummary(page.platform)
    if (summary) s += `  (${summary})`
  }
  return s
}

function renderText(root: Work, page: PageMeta, detail: boolean, totalPruned: number): string {
  const lines: string[] = [headerLine(page)]
  const walk = (w: Work, depth: number, isRoot: boolean): void => {
    lines.push(nodeLine(w, depth, isRoot))
    for (const c of w.children) walk(c, depth + 1, false)
    if (w.invisible.length > 0) lines.push(invisibleLine(w.invisible, depth + 1, detail))
  }
  walk(root, 0, true)
  if (totalPruned > 0) {
    lines.push(`  [${totalPruned} nodes pruned: budget — narrow with scope or find_elements]`)
  }
  return lines.join('\n')
}

/**
 * Render the page census per SPEC §8.1.
 * includeInvisible (extra optional param beyond the §11 signature) renders invisible
 * nodes inline with their reason instead of collapsing them into count brackets.
 */
export function renderCensus(
  root: SnapshotNode,
  page: PageMeta,
  budgetTokens: number,
  includeInvisible = false,
): string {
  const work = toWork(root, includeInvisible)
  let detail = true
  let totalPruned = 0
  let text = renderText(work, page, detail, totalPruned)
  if (estimateTokens(text) <= budgetTokens) return text

  // 1. Drop invisible subtrees, keeping counts.
  if (includeInvisible) {
    demoteInvisible(work)
    text = renderText(work, page, detail, totalPruned)
    if (estimateTokens(text) <= budgetTokens) return text
  }
  detail = false
  text = renderText(work, page, detail, totalPruned)
  if (estimateTokens(text) <= budgetTokens) return text

  // 2. Collapse single-child wrapper chains (no id, <=1 class, no layout hint, no text).
  totalPruned += collapseWrappers(work)
  text = renderText(work, page, detail, totalPruned)
  if (estimateTokens(text) <= budgetTokens) return text

  // 3. Truncate deepest level first until the budget fits (or only the root remains).
  while (estimateTokens(text) > budgetTokens) {
    const d = maxDepth(work)
    if (d < 1) break
    totalPruned += removeAtDepth(work, d)
    text = renderText(work, page, detail, totalPruned)
  }
  return text
}
