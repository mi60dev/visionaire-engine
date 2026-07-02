/**
 * Visibility decision tree — SPEC §6.2. Ordered checks 1–10, first hit wins.
 * Element + ancestor computed facts come from ONE in-page callFunctionOn
 * (cheaper than N CDP round-trips); occlusion probing stays protocol-side
 * via DOM.getNodeForLocation as mandated.
 */
import type { Protocol } from 'puppeteer-core'
import type { Bounds, ResolvedNode, ToolContext, VisibilityReport } from '../types.js'
import { pairAttributes } from '../uid.js'

const OBJECT_GROUP = 'visionaire-visibility'

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

interface NodeFacts {
  tag: string
  display: string
  visibility: string
  opacity: string
  overflowX: string
  overflowY: string
  clipPath: string
  contain: string
  contentVisibility: string
  color: string
  backgroundColor: string
  rect: Rect
}

interface SelfFacts extends NodeFacts {
  hasText: boolean
  hasPaintedChild: boolean
}

interface PageFacts {
  connected: boolean
  self?: SelfFacts
  ancestors?: NodeFacts[]
  viewport?: { width: number; height: number }
  scroll?: { x: number; y: number; width: number; height: number }
}

const FACTS_FN = `function () {
  const el = this
  if (!el || el.nodeType !== 1 || !el.isConnected) return { connected: false }
  const read = (node) => {
    const cs = getComputedStyle(node)
    const g = (p) => cs.getPropertyValue(p)
    const r = node.getBoundingClientRect()
    return {
      tag: node.tagName.toLowerCase(),
      display: g('display'), visibility: g('visibility'), opacity: g('opacity'),
      overflowX: g('overflow-x'), overflowY: g('overflow-y'),
      clipPath: g('clip-path'), contain: g('contain'),
      contentVisibility: g('content-visibility') || 'visible',
      color: g('color'), backgroundColor: g('background-color'),
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    }
  }
  const self = read(el)
  self.hasText = Array.from(el.childNodes).some(
    (n) => n.nodeType === 3 && n.textContent.trim().length > 0)
  self.hasPaintedChild = Array.from(el.children).some((c) => {
    const r = c.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  })
  const ancestors = []
  for (let p = el.parentElement; p; p = p.parentElement) ancestors.push(read(p))
  return {
    connected: true, self, ancestors,
    viewport: { width: innerWidth, height: innerHeight },
    scroll: { x: scrollX, y: scrollY,
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight },
  }
}`

const NTH_ANCESTOR_FN = `function (n) {
  let p = this.parentElement
  while (n > 0 && p) { p = p.parentElement; n-- }
  return p
}`

/** Runs against the TARGET element; the probe hit is passed as argument. */
const CLASSIFY_HIT_FN = `function (hit) {
  if (!hit || !(hit instanceof Node)) return 'occluder'
  const el = hit.nodeType === 1 ? hit : hit.parentElement
  if (!el) return 'occluder'
  if (el === this || this.contains(el)) return 'benign'
  if (el.contains(this)) {
    const s = getComputedStyle(el)
    const bg = s.getPropertyValue('background-color')
    const m = /rgba?\\(([^)]*)\\)/.exec(bg)
    let alpha = 1
    if (m) {
      const body = m[1]
      if (body.includes('/')) alpha = parseFloat(body.split('/')[1])
      else { const c = body.split(','); alpha = c.length === 4 ? parseFloat(c[3]) : 1 }
    } else if (bg === 'transparent') alpha = 0
    const noImage = s.getPropertyValue('background-image') === 'none'
    return alpha === 0 && noImage ? 'benign' : 'occluder'
  }
  return 'occluder'
}`

function toBounds(r: Rect): Bounds {
  const round1 = (n: number) => Math.round(n * 10) / 10
  return { x: round1(r.x), y: round1(r.y), width: round1(r.width), height: round1(r.height) }
}

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  return {
    x,
    y,
    width: Math.min(a.x + a.width, b.x + b.width) - x,
    height: Math.min(a.y + a.height, b.y + b.height) - y,
  }
}

function colorAlpha(color: string): number {
  const trimmed = color.trim()
  if (trimmed === 'transparent') return 0
  const m = /^rgba?\(([^)]*)\)$/.exec(trimmed)
  if (!m) return 1
  const body = m[1]
  if (body.includes('/')) return Number.parseFloat(body.split('/')[1])
  const comps = body.split(',')
  return comps.length === 4 ? Number.parseFloat(comps[3]) : 1
}

function shortUrl(url: string): string {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean)
    return parts.slice(-2).join('/') || url
  } catch {
    return url.split('/').slice(-2).join('/') || url
  }
}

interface AncestorRef {
  uid: string
  tag: string
  backendNodeId: number
  nodeId?: Protocol.DOM.NodeId
}

/** Resolve the n-th ancestor (0 = parent) to a uid + pushed nodeId. Best-effort. */
async function resolveAncestor(
  ctx: ToolContext,
  selfObjectId: string,
  index: number,
): Promise<AncestorRef | undefined> {
  try {
    const { result } = await ctx.cdp.send('Runtime.callFunctionOn', {
      objectId: selfObjectId,
      functionDeclaration: NTH_ANCESTOR_FN,
      arguments: [{ value: index }],
      objectGroup: OBJECT_GROUP,
    })
    if (!result.objectId) return undefined
    const { node } = await ctx.cdp.send('DOM.describeNode', { objectId: result.objectId })
    const attrs = pairAttributes(node.attributes)
    const tag = node.nodeName.toLowerCase()
    const uid = ctx.uids.assign(node.backendNodeId, {
      tag,
      classes: (attrs.get('class') ?? '').split(/\s+/).filter(Boolean),
      attrId: attrs.get('id'),
    })
    const { nodeIds } = await ctx.cdp.send('DOM.pushNodesByBackendIdsToFrontend', {
      backendNodeIds: [node.backendNodeId],
    })
    return { uid, tag, backendNodeId: node.backendNodeId, nodeId: nodeIds[0] }
  } catch {
    return undefined
  }
}

/**
 * Best-effort: highest-priority matched rule (or inline style) that sets
 * display:none on the given node. SPEC §6.2 — skip silently on failure.
 */
async function findDisplayNoneRule(
  ctx: ToolContext,
  nodeId: Protocol.DOM.NodeId,
): Promise<string | undefined> {
  try {
    const res = await ctx.cdp.send('CSS.getMatchedStylesForNode', { nodeId })
    const isDisplayNone = (p: Protocol.CSS.CSSProperty) =>
      p.name === 'display' && p.value.trim().replace(/\s*!important$/, '') === 'none' &&
      !p.disabled && p.parsedOk !== false
    if (res.inlineStyle?.cssProperties.some(isDisplayNone)) return 'set by inline style'
    const rules = res.matchedCSSRules ?? []
    // matchedCSSRules is ordered ascending by cascade priority → scan last-first.
    for (let i = rules.length - 1; i >= 0; i--) {
      const match = rules[i]
      const prop = match.rule.style.cssProperties.find(isDisplayNone)
      if (!prop) continue
      const selector =
        match.rule.selectorList.selectors[match.matchingSelectors[0] ?? 0]?.text ??
        match.rule.selectorList.text
      const sheet = match.rule.styleSheetId ? ctx.sheets.get(match.rule.styleSheetId) : undefined
      const range = prop.range ?? match.rule.style.range
      const line = range ? range.startLine + 1 : undefined
      const loc = sheet?.sourceURL
        ? ` at ${shortUrl(sheet.sourceURL)}${line !== undefined ? `:${line}` : ''}`
        : ''
      return `set by ${selector}${loc}`
    }
  } catch {
    /* best-effort */
  }
  return undefined
}

export async function assessVisibility(
  ctx: ToolContext,
  node: ResolvedNode,
): Promise<VisibilityReport> {
  let selfObjectId: string | undefined
  let facts: PageFacts | undefined
  try {
    const { object } = await ctx.cdp.send('DOM.resolveNode', {
      backendNodeId: node.backendNodeId,
      objectGroup: OBJECT_GROUP,
    })
    selfObjectId = object.objectId
    if (selfObjectId) {
      const res = await ctx.cdp.send('Runtime.callFunctionOn', {
        objectId: selfObjectId,
        functionDeclaration: FACTS_FN,
        returnByValue: true,
      })
      if (!res.exceptionDetails) facts = res.result.value as PageFacts
    }
  } catch {
    /* fall through → detached */
  }

  try {
    // 1. detached
    if (!facts?.connected || !facts.self || !facts.ancestors || !facts.viewport || !facts.scroll) {
      return {
        status: 'detached',
        visible: false,
        cause: 'node is not attached to the document (no layout object)',
      }
    }
    const { self, ancestors, viewport, scroll } = facts

    // 2. display-none (self, then nearest ancestor with rule attribution)
    if (self.display === 'none') {
      const rule = await findDisplayNoneRule(ctx, node.nodeId)
      return {
        status: 'display-none',
        visible: false,
        cause: `display:none on the element itself${rule ? ` (${rule})` : ''}`,
      }
    }
    const dnIdx = ancestors.findIndex((a) => a.display === 'none')
    if (dnIdx >= 0 && selfObjectId) {
      const anc = await resolveAncestor(ctx, selfObjectId, dnIdx)
      const rule = anc?.nodeId ? await findDisplayNoneRule(ctx, anc.nodeId) : undefined
      return {
        status: 'display-none',
        visible: false,
        cause: `ancestor ${anc?.uid ?? `<${ancestors[dnIdx].tag}>`} has display:none${rule ? ` (${rule})` : ''}`,
        causeUid: anc?.uid,
      }
    }

    const rect = self.rect
    const bounds = toBounds(rect)

    // 3. visibility-hidden (inherited — attribute the outermost hidden node)
    if (self.visibility === 'hidden' || self.visibility === 'collapse') {
      let srcIdx = -1
      while (srcIdx + 1 < ancestors.length && ancestors[srcIdx + 1].visibility === self.visibility) {
        srcIdx++
      }
      if (srcIdx >= 0 && selfObjectId) {
        const anc = await resolveAncestor(ctx, selfObjectId, srcIdx)
        return {
          status: 'visibility-hidden',
          visible: false,
          cause: `visibility:${self.visibility} inherited from ancestor ${anc?.uid ?? `<${ancestors[srcIdx].tag}>`}`,
          causeUid: anc?.uid,
          bounds,
        }
      }
      return {
        status: 'visibility-hidden',
        visible: false,
        cause: `visibility:${self.visibility} on the element itself`,
        bounds,
      }
    }

    // 4. zero-size (unless visible overflow lets children paint)
    const overflowVisible = self.overflowX === 'visible' && self.overflowY === 'visible'
    if ((rect.width === 0 || rect.height === 0) && !(overflowVisible && self.hasPaintedChild)) {
      return {
        status: 'zero-size',
        visible: false,
        cause: `border-box is ${bounds.width}x${bounds.height}`,
        bounds,
      }
    }

    // 5. opacity-zero (effective = product over self + ancestors)
    let effectiveOpacity = Number.parseFloat(self.opacity) || 0
    for (const a of ancestors) effectiveOpacity *= Number.parseFloat(a.opacity) || 0
    if (effectiveOpacity <= 0.001) {
      if (Number.parseFloat(self.opacity) === 0) {
        return { status: 'opacity-zero', visible: false, cause: 'opacity:0 on the element itself', bounds }
      }
      const opIdx = ancestors.findIndex((a) => Number.parseFloat(a.opacity) === 0)
      const anc = opIdx >= 0 && selfObjectId ? await resolveAncestor(ctx, selfObjectId, opIdx) : undefined
      return {
        status: 'opacity-zero',
        visible: false,
        cause: anc
          ? `ancestor ${anc.uid} has opacity:0`
          : `accumulated ancestor opacity is ~0 (${effectiveOpacity})`,
        causeUid: anc?.uid,
        bounds,
      }
    }

    // 6. off-viewport
    const outsideViewport =
      rect.x + rect.width <= 0 ||
      rect.x >= viewport.width ||
      rect.y + rect.height <= 0 ||
      rect.y >= viewport.height
    if (outsideViewport) {
      const dirs: string[] = []
      let dist = 0
      if (rect.y + rect.height <= 0) {
        dirs.push('above')
        dist = Math.max(dist, -(rect.y + rect.height))
      }
      if (rect.y >= viewport.height) {
        dirs.push('below')
        dist = Math.max(dist, rect.y - viewport.height)
      }
      if (rect.x + rect.width <= 0) {
        dirs.push('left of')
        dist = Math.max(dist, -(rect.x + rect.width))
      }
      if (rect.x >= viewport.width) {
        dirs.push('right of')
        dist = Math.max(dist, rect.x - viewport.width)
      }
      const docX = rect.x + scroll.x
      const docY = rect.y + scroll.y
      const inDocument =
        docX < scroll.width && docX + rect.width > 0 && docY < scroll.height && docY + rect.height > 0
      let scrollNote = 'not reachable by scrolling'
      if (inDocument) {
        const dir = dirs.includes('below')
          ? `down ${Math.ceil(rect.y + rect.height - viewport.height)}px`
          : dirs.includes('above')
            ? `up ${Math.ceil(-rect.y)}px`
            : dirs.includes('right of')
              ? `right ${Math.ceil(rect.x + rect.width - viewport.width)}px`
              : `left ${Math.ceil(-rect.x)}px`
        scrollNote = `scrollable to (scroll ${dir})`
      }
      return {
        status: 'off-viewport',
        visible: false,
        cause: `${dirs.join(' and ')} the viewport, ${Math.round(dist)}px beyond the edge — ${scrollNote}`,
        bounds,
      }
    }

    // 7. clipped (running intersection of ancestor clip boxes, nearest → root)
    let clipRect: Rect = { x: -1e9, y: -1e9, width: 2e9, height: 2e9 }
    for (let i = 0; i < ancestors.length; i++) {
      const a = ancestors[i]
      if (a.contentVisibility === 'hidden') {
        const anc = selfObjectId ? await resolveAncestor(ctx, selfObjectId, i) : undefined
        return {
          status: 'clipped',
          visible: false,
          cause: `ancestor ${anc?.uid ?? `<${a.tag}>`} has content-visibility:hidden`,
          causeUid: anc?.uid,
          bounds,
        }
      }
      const clips =
        a.overflowX !== 'visible' ||
        a.overflowY !== 'visible' ||
        a.clipPath !== 'none' ||
        /\b(paint|strict|content)\b/.test(a.contain)
      if (!clips) continue
      clipRect = intersect(clipRect, a.rect)
      const visiblePart = intersect(clipRect, rect)
      if (visiblePart.width <= 0 || visiblePart.height <= 0) {
        const anc = selfObjectId ? await resolveAncestor(ctx, selfObjectId, i) : undefined
        const why =
          a.overflowX !== 'visible' || a.overflowY !== 'visible'
            ? `overflow:${a.overflowX === a.overflowY ? a.overflowX : `${a.overflowX}/${a.overflowY}`}`
            : a.clipPath !== 'none'
              ? 'clip-path'
              : `contain:${a.contain}`
        return {
          status: 'clipped',
          visible: false,
          cause: `clipped by ancestor ${anc?.uid ?? `<${a.tag}>`} (${why})`,
          causeUid: anc?.uid,
          bounds,
        }
      }
    }

    // 8. occluded — protocol-side DOM.getNodeForLocation probes (spec-mandated).
    const cx = rect.x + rect.width / 2
    const cy = rect.y + rect.height / 2
    const qw = rect.width / 4
    const qh = rect.height / 4
    const points = [
      [cx, cy],
      [cx - qw, cy - qh],
      [cx + qw, cy - qh],
      [cx - qw, cy + qh],
      [cx + qw, cy + qh],
    ]
      .map(([x, y]) => [Math.round(x), Math.round(y)] as const)
      .filter(([x, y]) => x >= 0 && x < viewport.width && y >= 0 && y < viewport.height)

    let centerBenign: boolean | undefined
    if (points.length >= 3 && selfObjectId) {
      const kindCache = new Map<number, string>()
      const occluderHits = new Map<number, number>()
      let occluding = 0
      for (let p = 0; p < points.length; p++) {
        let hitBid: number | undefined
        try {
          // ignorePointerEventsNone: paint-order semantics — pointer-events:none
          // overlays still visually occlude.
          const res = await ctx.cdp.send('DOM.getNodeForLocation', {
            x: points[p][0],
            y: points[p][1],
            includeUserAgentShadowDOM: false,
            ignorePointerEventsNone: true,
          })
          hitBid = res.backendNodeId
        } catch {
          continue
        }
        if (hitBid === undefined) continue
        let kind = kindCache.get(hitBid)
        if (kind === undefined) {
          if (hitBid === node.backendNodeId) kind = 'benign'
          else {
            try {
              const { object } = await ctx.cdp.send('DOM.resolveNode', {
                backendNodeId: hitBid,
                objectGroup: OBJECT_GROUP,
              })
              const cls = await ctx.cdp.send('Runtime.callFunctionOn', {
                objectId: selfObjectId,
                functionDeclaration: CLASSIFY_HIT_FN,
                arguments: object.objectId ? [{ objectId: object.objectId }] : [{ value: null }],
                returnByValue: true,
              })
              kind = String(cls.result.value ?? 'occluder')
            } catch {
              kind = 'benign'
            }
          }
          kindCache.set(hitBid, kind)
        }
        if (p === 0) centerBenign = kind === 'benign'
        if (kind === 'occluder') {
          occluding++
          occluderHits.set(hitBid, (occluderHits.get(hitBid) ?? 0) + 1)
        }
      }
      if (occluding >= 3) {
        let topBid: number | undefined
        let topCount = 0
        for (const [bid, count] of occluderHits) {
          if (count > topCount) {
            topBid = bid
            topCount = count
          }
        }
        let uid: string | undefined
        let tag = ''
        if (topBid !== undefined) {
          try {
            const { node: occNode } = await ctx.cdp.send('DOM.describeNode', {
              backendNodeId: topBid,
            })
            const attrs = pairAttributes(occNode.attributes)
            tag = occNode.nodeName.toLowerCase()
            uid = ctx.uids.assign(occNode.backendNodeId, {
              tag,
              classes: (attrs.get('class') ?? '').split(/\s+/).filter(Boolean),
              attrId: attrs.get('id'),
            })
          } catch {
            /* best-effort */
          }
        }
        return {
          status: 'occluded',
          visible: false,
          cause: `occluded by ${uid ?? 'another element'}${tag ? ` <${tag}>` : ''} — ${occluding}/${points.length} probes hit it`,
          causeUid: uid,
          bounds,
        }
      }
    }

    // 9. transparent-text (text-bearing elements only)
    if (self.hasText) {
      if (colorAlpha(self.color) === 0) {
        return {
          status: 'transparent-text',
          visible: false,
          cause: `text color is fully transparent (${self.color})`,
          bounds,
        }
      }
      if (colorAlpha(self.backgroundColor) > 0 && self.backgroundColor === self.color) {
        return {
          status: 'transparent-text',
          visible: false,
          cause: `text color equals background color (${self.color}) — invisible ink`,
          bounds,
        }
      }
    }

    // 10. visible
    return {
      status: 'visible',
      visible: true,
      cause: centerBenign ? 'paints on top at center' : undefined,
      bounds,
    }
  } finally {
    void ctx.cdp.send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => {})
  }
}
