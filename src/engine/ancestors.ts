/**
 * Ancestor constraint walk — SPEC §6.5. One in-page callFunctionOn collects
 * concern-relevant computed facts for the whole self→root chain; a second
 * returns the chain elements as remote objects so each gets a stable uid.
 *
 * Binding detection is heuristic where CSS makes it undetectable from
 * computed values alone (computed width is always resolved px, so "explicit
 * width" is inferred from inline style / max-width / flex-basis).
 */
import type { AncestorLine, ResolvedNode, ToolContext } from '../types.js'
import { pairAttributes } from '../uid.js'
import { stackingContextReason } from './stacking.js'

export type AncestorConcern = 'width' | 'height' | 'position' | 'overflow' | 'stacking'

const OBJECT_GROUP = 'visionaire-ancestors'

interface ChainFacts {
  rect: { x: number; y: number; width: number; height: number }
  display: string
  position: string
  top: string
  right: string
  bottom: string
  left: string
  transform: string
  width: string
  maxWidth: string
  minWidth: string
  height: string
  maxHeight: string
  minHeight: string
  boxSizing: string
  paddingLeft: string
  paddingRight: string
  paddingTop: string
  paddingBottom: string
  flexBasis: string
  flexGrow: string
  flexShrink: string
  overflowX: string
  overflowY: string
  clipPath: string
  contain: string
  contentVisibility: string
  zIndex: string
  opacity: string
  filter: string
  perspective: string
  maskImage: string
  backdropFilter: string
  isolation: string
  mixBlendMode: string
  willChange: string
  inlineWidth: string
  inlineHeight: string
  parentDisplay: string
  parentFlexDirection: string
  parentOverflowsX: boolean
  parentOverflowsY: boolean
}

const FACTS_FN = `function () {
  const read = (el, parent) => {
    const cs = getComputedStyle(el)
    const pcs = parent ? getComputedStyle(parent) : null
    const g = (p) => cs.getPropertyValue(p)
    const r = el.getBoundingClientRect()
    return {
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      display: g('display'), position: g('position'),
      top: g('top'), right: g('right'), bottom: g('bottom'), left: g('left'),
      transform: g('transform'),
      width: g('width'), maxWidth: g('max-width'), minWidth: g('min-width'),
      height: g('height'), maxHeight: g('max-height'), minHeight: g('min-height'),
      boxSizing: g('box-sizing'),
      paddingLeft: g('padding-left'), paddingRight: g('padding-right'),
      paddingTop: g('padding-top'), paddingBottom: g('padding-bottom'),
      flexBasis: g('flex-basis'), flexGrow: g('flex-grow'), flexShrink: g('flex-shrink'),
      overflowX: g('overflow-x'), overflowY: g('overflow-y'),
      clipPath: g('clip-path'), contain: g('contain'),
      contentVisibility: g('content-visibility') || 'visible',
      zIndex: g('z-index'), opacity: g('opacity'), filter: g('filter'),
      perspective: g('perspective'),
      maskImage: g('mask-image') || g('-webkit-mask-image') || 'none',
      backdropFilter: g('backdrop-filter'), isolation: g('isolation'),
      mixBlendMode: g('mix-blend-mode'), willChange: g('will-change'),
      inlineWidth: el.style ? el.style.width : '',
      inlineHeight: el.style ? el.style.height : '',
      parentDisplay: pcs ? pcs.display : '',
      parentFlexDirection: pcs ? pcs.flexDirection : '',
      parentOverflowsX: parent ? parent.scrollWidth > parent.clientWidth + 1 : false,
      parentOverflowsY: parent ? parent.scrollHeight > parent.clientHeight + 1 : false,
    }
  }
  const out = []
  for (let el = this; el; el = el.parentElement) out.push(read(el, el.parentElement))
  return out
}`

const CHAIN_FN = `function () {
  const out = [this]
  for (let p = this.parentElement; p; p = p.parentElement) out.push(p)
  return out
}`

const isFlex = (display: string): boolean => /\bflex\b/.test(display)
const isFlexOrGrid = (display: string): boolean => /\b(flex|grid)\b/.test(display)

/**
 * Implicit min-size trap of flex items (CSS Flexbox §4.5): a row flex item
 * with min-width:auto cannot shrink below its content's min-content size, so
 * the row overflows instead. Detectable purely from computed facts (verified
 * empirically on real Chrome): computed min-width stays the literal 'auto' on
 * flex items, and parent.scrollWidth exposes the row overflow even with
 * overflow:visible. Guards: the automatic minimum only applies while the
 * item's overflow is visible (any other value drops it to zero), and only an
 * item that is allowed to shrink at all (flex-shrink > 0) has anything to
 * blame on its minimum. Column analog below for min-height.
 */
const flexMinWidthTrap = (f: ChainFacts): boolean =>
  isFlex(f.parentDisplay) &&
  f.parentFlexDirection.startsWith('row') &&
  f.minWidth === 'auto' &&
  parseFloat(f.flexShrink) > 0 &&
  f.overflowX === 'visible' &&
  f.parentOverflowsX

const flexMinHeightTrap = (f: ChainFacts): boolean =>
  isFlex(f.parentDisplay) &&
  f.parentFlexDirection.startsWith('column') &&
  f.minHeight === 'auto' &&
  parseFloat(f.flexShrink) > 0 &&
  f.overflowY === 'visible' &&
  f.parentOverflowsY

function stackingMap(f: ChainFacts): Map<string, string> {
  return new Map([
    ['position', f.position],
    ['z-index', f.zIndex],
    ['opacity', f.opacity],
    ['transform', f.transform],
    ['filter', f.filter],
    ['perspective', f.perspective],
    ['clip-path', f.clipPath],
    ['mask-image', f.maskImage],
    ['backdrop-filter', f.backdropFilter],
    ['isolation', f.isolation],
    ['mix-blend-mode', f.mixBlendMode],
    ['will-change', f.willChange],
    ['contain', f.contain],
    ['parent-display', f.parentDisplay],
  ])
}

function summarize(concern: AncestorConcern, f: ChainFacts, isRoot: boolean): string {
  const parts: string[] = []
  switch (concern) {
    case 'width': {
      parts.push(`width:${f.width}`)
      if (f.maxWidth !== 'none') parts.push(`max-width:${f.maxWidth}`)
      if (f.minWidth !== '0px' && f.minWidth !== 'auto') parts.push(`min-width:${f.minWidth}`)
      if (flexMinWidthTrap(f)) {
        parts.push('min-width:auto (flex item) — prevents shrinking below content')
      }
      if (f.boxSizing !== 'content-box') parts.push(`box-sizing:${f.boxSizing}`)
      if (f.paddingLeft !== '0px' || f.paddingRight !== '0px') {
        parts.push(
          f.paddingLeft === f.paddingRight
            ? `padding-x:${f.paddingLeft}`
            : `padding-x:${f.paddingLeft}/${f.paddingRight}`,
        )
      }
      if (f.display !== 'block') parts.push(`display:${f.display}`)
      if (isFlex(f.parentDisplay) && f.flexBasis !== 'auto') parts.push(`flex-basis:${f.flexBasis}`)
      if (f.inlineWidth) parts.push(`style="width:${f.inlineWidth}"`)
      break
    }
    case 'height': {
      parts.push(`height:${f.height}`)
      if (f.maxHeight !== 'none') parts.push(`max-height:${f.maxHeight}`)
      if (f.minHeight !== '0px' && f.minHeight !== 'auto') parts.push(`min-height:${f.minHeight}`)
      if (flexMinHeightTrap(f)) {
        parts.push('min-height:auto (flex item) — prevents shrinking below content')
      }
      if (f.boxSizing !== 'content-box') parts.push(`box-sizing:${f.boxSizing}`)
      if (f.paddingTop !== '0px' || f.paddingBottom !== '0px') {
        parts.push(
          f.paddingTop === f.paddingBottom
            ? `padding-y:${f.paddingTop}`
            : `padding-y:${f.paddingTop}/${f.paddingBottom}`,
        )
      }
      if (f.display !== 'block') parts.push(`display:${f.display}`)
      if (isFlex(f.parentDisplay) && f.flexBasis !== 'auto') parts.push(`flex-basis:${f.flexBasis}`)
      if (f.inlineHeight) parts.push(`style="height:${f.inlineHeight}"`)
      break
    }
    case 'position': {
      parts.push(`position:${f.position}`)
      if (f.position !== 'static') {
        for (const [name, value] of [
          ['top', f.top],
          ['right', f.right],
          ['bottom', f.bottom],
          ['left', f.left],
        ] as const) {
          if (value !== 'auto') parts.push(`${name}:${value}`)
        }
        if (f.zIndex !== 'auto') parts.push(`z-index:${f.zIndex}`)
      }
      // A transformed ancestor is the containing block even for position:fixed.
      if (f.transform !== 'none') parts.push('transform:set (containing block)')
      break
    }
    case 'overflow': {
      parts.push(
        f.overflowX === f.overflowY
          ? `overflow:${f.overflowX}`
          : `overflow-x:${f.overflowX} overflow-y:${f.overflowY}`,
      )
      if (f.clipPath !== 'none') {
        parts.push(`clip-path:${f.clipPath.length > 30 ? `${f.clipPath.slice(0, 27)}…` : f.clipPath}`)
      }
      if (/\b(layout|paint|strict|content)\b/.test(f.contain)) parts.push(`contain:${f.contain}`)
      if (f.contentVisibility !== 'visible') parts.push(`content-visibility:${f.contentVisibility}`)
      break
    }
    case 'stacking': {
      parts.push(`z-index:${f.zIndex}`)
      if (f.position !== 'static') parts.push(`position:${f.position}`)
      const reason = isRoot ? 'root stacking context' : stackingContextReason(stackingMap(f))
      if (reason) parts.push(reason)
      break
    }
  }
  return parts.join(' ')
}

function isBinding(concern: AncestorConcern, f: ChainFacts, isRoot: boolean): boolean {
  switch (concern) {
    case 'width':
      return (
        f.inlineWidth !== '' ||
        f.maxWidth !== 'none' ||
        (isFlex(f.parentDisplay) && f.flexBasis !== 'auto') ||
        flexMinWidthTrap(f)
      )
    case 'height':
      return (
        f.inlineHeight !== '' ||
        f.maxHeight !== 'none' ||
        (isFlex(f.parentDisplay) && f.flexBasis !== 'auto') ||
        flexMinHeightTrap(f)
      )
    case 'overflow':
      return f.overflowX !== 'visible' || f.overflowY !== 'visible'
    case 'position':
      // Nearest containing block for absolutely/fixed positioned descendants.
      return f.position !== 'static' || f.transform !== 'none'
    case 'stacking':
      return isRoot || stackingContextReason(stackingMap(f)) !== undefined
  }
}

export async function walkAncestors(
  ctx: ToolContext,
  node: ResolvedNode,
  concern: AncestorConcern,
): Promise<AncestorLine[]> {
  const { object } = await ctx.cdp.send('DOM.resolveNode', {
    backendNodeId: node.backendNodeId,
    objectGroup: OBJECT_GROUP,
  })
  if (!object.objectId) throw new Error('Could not resolve the element to a live object.')

  try {
    const factsRes = await ctx.cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: FACTS_FN,
      returnByValue: true,
    })
    if (factsRes.exceptionDetails) {
      throw new Error(`Ancestor walk failed in page: ${factsRes.exceptionDetails.text}`)
    }
    const facts = factsRes.result.value as ChainFacts[]

    const chainRes = await ctx.cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: CHAIN_FN,
      objectGroup: OBJECT_GROUP,
    })
    if (!chainRes.result.objectId) throw new Error('Ancestor walk failed: no chain object.')
    const props = await ctx.cdp.send('Runtime.getProperties', {
      objectId: chainRes.result.objectId,
      ownProperties: true,
    })
    const elementObjectIds = props.result
      .filter((p) => /^\d+$/.test(p.name) && p.value?.objectId)
      .sort((a, b) => Number(a.name) - Number(b.name))
      .map((p) => p.value!.objectId!)

    const count = Math.min(facts.length, elementObjectIds.length)
    const lines: AncestorLine[] = []
    let bindingAssigned = false

    for (let i = 0; i < count; i++) {
      const f = facts[i]
      const isRoot = i === count - 1
      const { node: described } = await ctx.cdp.send('DOM.describeNode', {
        objectId: elementObjectIds[i],
      })
      const attrs = pairAttributes(described.attributes)
      const tag = described.nodeName.toLowerCase()
      const classes = (attrs.get('class') ?? '').split(/\s+/).filter(Boolean)
      const attrId = attrs.get('id')
      const uid = ctx.uids.assign(described.backendNodeId, { tag, classes, attrId })
      const line: AncestorLine = { uid, tag, classes, summary: summarize(concern, f, isRoot) }
      if (attrId) line.attrId = attrId
      // Binding constraint: nearest qualifying ANCESTOR (never self, i=0) —
      // except the flex min-size trap, which genuinely lives on the element
      // itself (its own implicit min-width/height:auto is the shrink blocker).
      const selfBinds =
        i === 0 &&
        (concern === 'width'
          ? flexMinWidthTrap(f)
          : concern === 'height'
            ? flexMinHeightTrap(f)
            : false)
      if (!bindingAssigned && (selfBinds || (i > 0 && isBinding(concern, f, isRoot)))) {
        line.binding = true
        bindingAssigned = true
      }
      lines.push(line)
    }
    return lines
  } finally {
    void ctx.cdp.send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => {})
  }
}
