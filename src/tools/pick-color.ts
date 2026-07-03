/**
 * pick_color — painted-pixel truth: sample the ACTUAL composited color at a point
 * or element (gradients, images, opacity stacks — everything computed styles
 * cannot see), join it with the owning element's computed colors, and give a
 * WCAG contrast verdict for the text against the painted backdrop.
 */
import { z } from 'zod'
import type { ToolContext, ToolDef } from '../types.js'
import { pairAttributes, resolveTarget } from '../uid.js'
import { decodePng } from '../engine/png.js'
import { contrastRatio, contrastVerdict, parseCssColor, toHex, type Rgba } from '../engine/color.js'

const inputSchema = {
  x: z.number().optional().describe('Viewport x of the pixel to sample (use with y)'),
  y: z.number().optional().describe('Viewport y of the pixel to sample (use with x)'),
  uid: z.string().optional().describe('Element uid — samples inside it (see at)'),
  selector: z.string().optional().describe('CSS selector — first match'),
  at: z
    .enum(['center', 'top-left'])
    .optional()
    .describe(
      "Sample point within the element: 'center' (default; may hit text glyphs) or 'top-left' " +
        '(2px inside the border — usually pure background)',
    ),
}

export const pickColorTool: ToolDef = {
  name: 'pick_color',
  description:
    'Sample the actual painted pixel color at a point/element, with computed colors and a WCAG contrast verdict.',
  inputSchema,
  async handler(ctx, args) {
    const hasXY = typeof args.x === 'number' && typeof args.y === 'number'
    const hasTarget = typeof args.uid === 'string' || typeof args.selector === 'string'
    if (hasXY === hasTarget) {
      throw new Error('Provide exactly one of: x+y coordinates, or uid/selector.')
    }

    let px: number
    let py: number
    let node
    if (hasXY) {
      px = Math.round(args.x as number)
      py = Math.round(args.y as number)
      node = await resolveTarget(ctx, { x: px, y: py }).catch(() => undefined)
    } else {
      node = await resolveTarget(ctx, {
        uid: typeof args.uid === 'string' ? args.uid : undefined,
        selector: typeof args.selector === 'string' ? args.selector : undefined,
      })
      const { model } = await ctx.cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId })
      const q = model.border
      const xs = [q[0]!, q[2]!, q[4]!, q[6]!]
      const ys = [q[1]!, q[3]!, q[5]!, q[7]!]
      if (args.at === 'top-left') {
        px = Math.round(Math.min(...xs) + 2)
        py = Math.round(Math.min(...ys) + 2)
      } else {
        px = Math.round((Math.min(...xs) + Math.max(...xs)) / 2)
        py = Math.round((Math.min(...ys) + Math.max(...ys)) / 2)
      }
    }

    // 3x3 clip around the point; the center pixel is the sample.
    const clipX = Math.max(0, px - 1)
    const clipY = Math.max(0, py - 1)
    const shot = await ctx.cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: clipX, y: clipY, width: 3, height: 3, scale: 1 },
      fromSurface: true,
    })
    const png = decodePng(Buffer.from(shot.data, 'base64'))
    const painted = png.pixelAt(Math.min(px - clipX, png.width - 1), Math.min(py - clipY, png.height - 1))
    const paintedRgba: Rgba = [painted[0], painted[1], painted[2], painted[3] / 255]

    const lines: string[] = []
    let owner = `(${px},${py})`
    let computedColor: string | undefined
    let computedBg: string | undefined
    if (node) {
      const entry = ctx.uids.get(node.uid)
      let tag = entry?.tag
      let attrId = entry?.attrId
      let classes = entry?.classes ?? []
      if (!tag) {
        const d = await ctx.cdp.send('DOM.describeNode', { backendNodeId: node.backendNodeId })
        const attrs = pairAttributes(d.node.attributes)
        tag = d.node.nodeName.toLowerCase()
        attrId = attrs.get('id')
        classes = (attrs.get('class') ?? '').split(/\s+/).filter(Boolean)
      }
      owner = `${node.uid} <${tag}${attrId ? `#${attrId}` : ''}${classes
        .slice(0, 2)
        .map((c) => `.${c}`)
        .join('')}>`
      const { computedStyle } = await ctx.cdp.send('CSS.getComputedStyleForNode', { nodeId: node.nodeId })
      for (const p of computedStyle) {
        if (p.name === 'color') computedColor = p.value
        if (p.name === 'background-color') computedBg = p.value
      }
    }

    lines.push(`color at (${px},${py}) — ${hasXY ? `inside ${owner}` : owner}${args.at === 'top-left' ? ' (top-left sample)' : ''}`)
    lines.push(`painted pixel: rgb(${painted[0]},${painted[1]},${painted[2]}) ${toHex(paintedRgba)}`)
    if (computedColor || computedBg) {
      lines.push(`computed: color ${computedColor ?? '?'} | background-color ${computedBg ?? '?'}`)
      if (computedBg === 'rgba(0, 0, 0, 0)') {
        lines.push('note: computed background is transparent — the painted pixel shows the real backdrop behind it')
      }
    }
    const textColor = computedColor ? parseCssColor(computedColor) : undefined
    if (textColor) {
      const ratio = contrastRatio(textColor, paintedRgba)
      lines.push(`contrast (computed text color vs painted pixel): ${contrastVerdict(ratio)}`)
      if (args.at !== 'top-left' && !hasXY) {
        lines.push("note: 'center' sampling can land on a text glyph — re-run with at:'top-left' for pure background")
      }
    }
    return { text: lines.join('\n') }
  },
}
