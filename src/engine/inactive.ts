/**
 * Inactive-declaration rules — SPEC §6.3, a port of the idea behind Firefox's
 * inactive-css: "you set it, but it does nothing because…".
 * Pure function over declarations + computed styles; one table entry per rule.
 */
import type { DeclarationInfo, InactiveFinding } from '../types.js'

interface RuleCtx {
  display: string
  position: string
  parentDisplay?: string
  parentIsFlex: boolean
  parentIsGrid: boolean
  computed: Map<string, string>
}

interface InactiveRule {
  match: (decl: DeclarationInfo, ctx: RuleCtx) => boolean
  reason: (decl: DeclarationInfo, ctx: RuleCtx) => string
  fixHint: (decl: DeclarationInfo, ctx: RuleCtx) => string | undefined
}

const SIDES = ['top', 'right', 'bottom', 'left'] as const

const SIZE_PROPS = new Set(['width', 'height', 'min-width', 'min-height', 'max-width', 'max-height'])
const INSET_PROPS = new Set([...SIDES, 'inset'])
const FLEX_ONLY_ITEM_PROPS = new Set(['flex', 'flex-grow', 'flex-shrink', 'flex-basis'])
const FLEX_OR_GRID_ITEM_PROPS = new Set(['order', 'align-self'])
const GRID_ITEM_PROPS = new Set([
  'grid-area', 'grid-row', 'grid-column',
  'grid-row-start', 'grid-row-end', 'grid-column-start', 'grid-column-end',
  'justify-self',
])
const CONTAINER_PROPS = new Set([
  'justify-content', 'align-items', 'align-content',
  'gap', 'row-gap', 'column-gap', 'flex-direction', 'flex-wrap',
])
const FLEX_DISPLAYS = new Set(['flex', 'inline-flex'])
const GRID_DISPLAYS = new Set(['grid', 'inline-grid'])

// display:inline heuristic — replaced inline elements (img, input, …) DO honor
// width/height/vertical margins, but replaced-ness is not visible in computed
// styles; the caller filters those tags if it cares.
const isInlineLevel = (ctx: RuleCtx): boolean => ctx.display === 'inline'
const isFlexOrGridContainer = (ctx: RuleCtx): boolean =>
  FLEX_DISPLAYS.has(ctx.display) || GRID_DISPLAYS.has(ctx.display)

const RULES: InactiveRule[] = [
  {
    match: (d, ctx) => SIZE_PROPS.has(d.property) && isInlineLevel(ctx),
    reason: (d) => `'${d.property}' has no effect on a non-replaced inline element`,
    fixHint: () => 'add display:block or display:inline-block',
  },
  {
    match: (d, ctx) =>
      (d.property === 'margin-top' || d.property === 'margin-bottom') && isInlineLevel(ctx),
    reason: (d) => `vertical '${d.property}' has no effect on a non-replaced inline element`,
    fixHint: () => 'add display:block or display:inline-block',
  },
  {
    match: (d, ctx) =>
      d.property === 'vertical-align' &&
      !ctx.display.startsWith('inline') &&
      ctx.display !== 'table-cell',
    reason: (d, ctx) =>
      `'vertical-align' only applies to inline-level and table-cell elements (this element is display:${ctx.display})`,
    fixHint: () => 'apply it to an inline-level child, or align via flex on the parent',
  },
  {
    match: (d, ctx) =>
      ctx.parentDisplay !== undefined &&
      !ctx.parentIsFlex &&
      (FLEX_ONLY_ITEM_PROPS.has(d.property) ||
        (FLEX_OR_GRID_ITEM_PROPS.has(d.property) && !ctx.parentIsGrid)),
    reason: (d, ctx) =>
      `'${d.property}' only affects ${FLEX_OR_GRID_ITEM_PROPS.has(d.property) ? 'flex or grid items' : 'flex items'}, but the parent is display:${ctx.parentDisplay}`,
    fixHint: () => 'set display:flex (or inline-flex) on the parent',
  },
  {
    match: (d, ctx) =>
      ctx.parentDisplay !== undefined && !ctx.parentIsGrid && GRID_ITEM_PROPS.has(d.property),
    reason: (d, ctx) =>
      `'${d.property}' only affects grid items, but the parent is display:${ctx.parentDisplay}`,
    fixHint: () => 'set display:grid (or inline-grid) on the parent',
  },
  {
    match: (d, ctx) => CONTAINER_PROPS.has(d.property) && !isFlexOrGridContainer(ctx),
    reason: (d, ctx) =>
      `'${d.property}' only affects flex or grid containers (this element is display:${ctx.display})`,
    fixHint: () => 'add display:flex or display:grid to this element',
  },
  {
    // z-index DOES apply to static flex/grid items, so those are excluded.
    match: (d, ctx) =>
      d.property === 'z-index' &&
      d.value.trim() !== 'auto' &&
      ctx.position === 'static' &&
      !ctx.parentIsFlex &&
      !ctx.parentIsGrid,
    reason: () =>
      `'z-index' has no effect on a position:static element that is not a flex or grid item`,
    fixHint: () => 'add position:relative (or absolute/fixed/sticky)',
  },
  {
    match: (d, ctx) =>
      INSET_PROPS.has(d.property) && d.value.trim() !== 'auto' && ctx.position === 'static',
    reason: (d) => `'${d.property}' has no effect on a position:static element`,
    fixHint: () => 'add position:relative (or absolute/fixed/sticky)',
  },
  {
    match: (d, ctx) =>
      d.property === 'float' && d.value.trim() !== 'none' && (ctx.parentIsFlex || ctx.parentIsGrid),
    reason: (d, ctx) => `'float' has no effect on a ${ctx.parentIsFlex ? 'flex' : 'grid'} item`,
    fixHint: () => 'use order, margins or alignment properties on the item instead',
  },
  {
    match: (d, ctx) => {
      if (d.property !== 'text-overflow' || !d.value.includes('ellipsis')) return false
      const overflowX = ctx.computed.get('overflow-x') ?? ctx.computed.get('overflow') ?? 'visible'
      const whiteSpace = ctx.computed.get('white-space') ?? 'normal'
      const clips = overflowX !== 'visible'
      const singleLine = whiteSpace === 'nowrap' || whiteSpace === 'pre'
      return !(clips && singleLine)
    },
    reason: () =>
      `'text-overflow: ellipsis' usually needs overflow:hidden and white-space:nowrap on the same element (heuristic)`,
    fixHint: () => 'add overflow:hidden and white-space:nowrap',
  },
  {
    // Note-level. The "inside overflow:hidden ancestor" half of the SPEC rule
    // needs ancestor data this pure function does not receive — engine/ancestors
    // territory.
    match: (d, ctx) =>
      d.property === 'position' &&
      d.value.trim() === 'sticky' &&
      SIDES.every((s) => (ctx.computed.get(s) ?? 'auto') === 'auto'),
    reason: () => `'position: sticky' without any inset (top/right/bottom/left) never sticks`,
    fixHint: () => 'add an inset, e.g. top:0',
  },
]

export function findInactiveDeclarations(
  decls: DeclarationInfo[],
  computed: Map<string, string>,
  parentDisplay?: string,
): InactiveFinding[] {
  const ctx: RuleCtx = {
    display: computed.get('display') ?? 'block',
    position: computed.get('position') ?? 'static',
    parentDisplay,
    parentIsFlex: parentDisplay !== undefined && FLEX_DISPLAYS.has(parentDisplay),
    parentIsGrid: parentDisplay !== undefined && GRID_DISPLAYS.has(parentDisplay),
    computed,
  }
  const findings: InactiveFinding[] = []
  for (const decl of decls) {
    for (const rule of RULES) {
      if (rule.match(decl, ctx)) {
        findings.push({ decl, reason: rule.reason(decl, ctx), fixHint: rule.fixHint(decl, ctx) })
        break // first matching table entry per declaration
      }
    }
  }
  return findings
}
