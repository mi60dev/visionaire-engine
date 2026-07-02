/**
 * DOM.getBoxModel → BoxSummary — SPEC §11.
 * Quads are [tlx,tly, trx,try, brx,bry, blx,bly]; under transforms the quad is
 * not axis-aligned, so content bounds use the quad's bounding box and side
 * widths use corner deltas (deterministic, approximate under rotation).
 */
import type { Protocol } from 'puppeteer-core'
import type { Bounds, BoxSummary, ResolvedNode, ToolContext } from '../types.js'

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function quadBounds(quad: Protocol.DOM.Quad): Bounds {
  const xs = [quad[0], quad[2], quad[4], quad[6]]
  const ys = [quad[1], quad[3], quad[5], quad[7]]
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return {
    x: round1(x),
    y: round1(y),
    width: round1(Math.max(...xs) - x),
    height: round1(Math.max(...ys) - y),
  }
}

/** [top, right, bottom, left] widths between an inner quad and its enclosing outer quad. */
function sideWidths(
  inner: Protocol.DOM.Quad,
  outer: Protocol.DOM.Quad,
): [number, number, number, number] {
  return [
    round1(inner[1] - outer[1]), // top: top-left y delta
    round1(outer[2] - inner[2]), // right: top-right x delta
    round1(outer[5] - inner[5]), // bottom: bottom-right y delta
    round1(inner[0] - outer[0]), // left: top-left x delta
  ]
}

/** Returns undefined when the node has no layout object (display:none, detached). */
export async function getBoxSummary(
  ctx: ToolContext,
  node: ResolvedNode,
): Promise<BoxSummary | undefined> {
  let model: Protocol.DOM.BoxModel
  try {
    ;({ model } = await ctx.cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId }))
  } catch {
    // CDP throws "Could not compute box model" for non-rendered nodes.
    return undefined
  }
  return {
    content: quadBounds(model.content),
    padding: sideWidths(model.content, model.padding),
    border: sideWidths(model.padding, model.border),
    margin: sideWidths(model.border, model.margin),
  }
}
