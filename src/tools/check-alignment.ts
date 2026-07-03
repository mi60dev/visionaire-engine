/**
 * check_alignment — pixel-perfect audit for a GROUP of elements: edge/center
 * alignment, gap rhythm, size consistency, grid conformance, pixel snap.
 */
import { z } from 'zod'
import type { ToolContext, ToolDef } from '../types.js'
import { sanitizePageText } from '../types.js'
import { analyzeAlignment, type AlignBox } from '../engine/alignment.js'

const inputSchema = {
  selector: z.string().optional().describe('CSS selector — audits ALL matches (2–40), e.g. ".nav li" or ".card"'),
  uids: z.array(z.string()).min(2).max(40).optional().describe('Explicit uids from a prior snapshot'),
  tolerance: z.number().min(0).max(10).optional().describe('Px within which values count as aligned (default 0.5)'),
  gridUnit: z.number().int().min(2).max(64).optional().describe('Also check lefts/tops against an N-px grid (e.g. 8)'),
}

interface GatheredBox {
  identity: string
  x: number
  y: number
  w: number
  h: number
}

const GATHER_FN = `function (selector) {
  const els = Array.prototype.slice.call(document.querySelectorAll(selector), 0, 40);
  const meta = els.map((el) => {
    const r = el.getBoundingClientRect();
    const id = el.id ? '#' + el.id : '';
    const cls = Array.prototype.slice.call(el.classList, 0, 2).map((c) => '.' + c).join('');
    return { identity: '<' + el.tagName.toLowerCase() + id + cls + '>', x: r.x, y: r.y, w: r.width, h: r.height };
  });
  return [JSON.stringify(meta)].concat(els);
}`

export const checkAlignmentTool: ToolDef = {
  name: 'check_alignment',
  description:
    'Pixel-perfect audit for a group of elements: alignment clusters, gap rhythm, size consistency, grid conformance, pixel snap.',
  inputSchema,
  async handler(ctx, args) {
    const selector = typeof args.selector === 'string' ? args.selector : undefined
    const uids = Array.isArray(args.uids) ? (args.uids as string[]) : undefined
    if ((selector ? 1 : 0) + (uids ? 1 : 0) !== 1) {
      throw new Error('Provide exactly one of: selector (audits all matches) or uids (2–40 from a snapshot).')
    }

    const boxes: AlignBox[] = []
    if (selector) {
      const { result, exceptionDetails } = await ctx.cdp.send('Runtime.evaluate', {
        expression: `(${GATHER_FN})(${JSON.stringify(selector)})`,
        returnByValue: false,
      })
      if (exceptionDetails || !result.objectId) {
        throw new Error(`Invalid CSS selector: ${selector}`)
      }
      const props = await ctx.cdp.send('Runtime.getProperties', { objectId: result.objectId, ownProperties: true })
      const indexed = props.result
        .filter((p) => /^\d+$/.test(p.name) && p.value !== undefined)
        .sort((a, b) => Number(a.name) - Number(b.name))
      const meta = JSON.parse(String(indexed[0]?.value?.value ?? '[]')) as GatheredBox[]
      if (meta.length < 2) {
        throw new Error(
          `selector "${selector}" matched ${meta.length} element(s) — an alignment audit needs at least 2.`,
        )
      }
      for (let i = 0; i < meta.length; i++) {
        const objectId = indexed[i + 1]?.value?.objectId
        let uid = `#${i + 1}`
        if (typeof objectId === 'string') {
          try {
            const described = await ctx.cdp.send('DOM.describeNode', { objectId })
            uid = ctx.uids.assign(described.node.backendNodeId)
          } catch {
            /* identity string still names the element */
          }
        }
        const m = meta[i]!
        boxes.push({ uid, identity: sanitizePageText(m.identity, 60), x: m.x, y: m.y, w: m.w, h: m.h })
      }
    } else {
      for (const uid of uids!) {
        const entry = ctx.uids.get(uid)
        if (!entry) throw new Error(`Unknown uid "${uid}" — take a fresh page_snapshot.`)
        const { model } = await ctx.cdp.send('DOM.getBoxModel', { backendNodeId: entry.backendNodeId })
        const q = model.border // [x1,y1, x2,y2, x3,y3, x4,y4]
        const xs = [q[0]!, q[2]!, q[4]!, q[6]!]
        const ys = [q[1]!, q[3]!, q[5]!, q[7]!]
        const x = Math.min(...xs)
        const y = Math.min(...ys)
        boxes.push({
          uid,
          identity: `<${entry.tag ?? '?'}${entry.attrId ? `#${entry.attrId}` : ''}>`,
          x,
          y,
          w: Math.max(...xs) - x,
          h: Math.max(...ys) - y,
        })
      }
    }

    const dprRes = await ctx.cdp.send('Runtime.evaluate', {
      expression: 'window.devicePixelRatio',
      returnByValue: true,
    })
    const dpr = typeof dprRes.result.value === 'number' ? dprRes.result.value : 1

    const lines = analyzeAlignment(boxes, {
      tolerance: typeof args.tolerance === 'number' ? args.tolerance : undefined,
      gridUnit: typeof args.gridUnit === 'number' ? args.gridUnit : undefined,
      dpr,
    })
    const legend = boxes
      .slice(0, 12)
      .map((b) => `  ${b.uid} ${b.identity} ${b.w.toFixed(1)}x${b.h.toFixed(1)} @(${b.x.toFixed(1)},${b.y.toFixed(1)})`)
      .join('\n')
    return {
      text: `${lines.join('\n')}\nelements:\n${legend}${boxes.length > 12 ? `\n  … +${boxes.length - 12} more` : ''}`,
    }
  },
}
