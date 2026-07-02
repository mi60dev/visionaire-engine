/**
 * inspect_element — the "what" dossier. SPEC §4, §8.2.
 */
import { z } from 'zod'
import type {
  ElementSummary,
  TargetSpec,
  ToolContext,
  ToolDef,
  WhatDossierInput,
} from '../types.js'
import { COMPUTED_WHITELIST } from '../types.js'
import { pairAttributes, resolveTarget } from '../uid.js'
import { getBoxSummary } from '../engine/box-model.js'
import { assessVisibility } from '../engine/visibility.js'
import { renderWhatDossier } from '../format/dossier.js'

const OBJECT_GROUP = 'visionaire-inspect'

/** Values dropped in non-verbose mode (property left = its initial/no-op value). */
const DROPPABLE_DEFAULTS: Record<string, string[]> = {
  position: ['static'],
  top: ['auto'],
  right: ['auto'],
  bottom: ['auto'],
  left: ['auto'],
  float: ['none'],
  clear: ['none'],
  'min-width': ['auto', '0px'],
  'min-height': ['auto', '0px'],
  'max-width': ['none'],
  'max-height': ['none'],
  'margin-top': ['0px'],
  'margin-right': ['0px'],
  'margin-bottom': ['0px'],
  'margin-left': ['0px'],
  'padding-top': ['0px'],
  'padding-right': ['0px'],
  'padding-bottom': ['0px'],
  'padding-left': ['0px'],
  'border-top-width': ['0px'],
  'border-right-width': ['0px'],
  'border-bottom-width': ['0px'],
  'border-left-width': ['0px'],
  'box-sizing': ['content-box'],
  'overflow-x': ['visible'],
  'overflow-y': ['visible'],
  'z-index': ['auto'],
  opacity: ['1'],
  visibility: ['visible'],
  transform: ['none'],
  'flex-direction': ['row'],
  'flex-grow': ['0'],
  'flex-shrink': ['1'],
  'flex-basis': ['auto'],
  'grid-template-columns': ['none'],
  'grid-template-rows': ['none'],
  gap: ['normal', 'normal normal', '0px', '0px 0px'],
  'align-items': ['normal'],
  'justify-content': ['normal'],
  'align-self': ['auto'],
  'justify-self': ['auto'],
  'line-height': ['normal'],
  'font-weight': ['400'],
  'background-color': ['rgba(0, 0, 0, 0)'],
  'text-align': ['start'],
  'white-space': ['normal'],
  'pointer-events': ['auto'],
  'content-visibility': ['visible'],
  'clip-path': ['none'],
  filter: ['none'],
  'mix-blend-mode': ['normal'],
}

function targetFromArgs(args: Record<string, unknown>): TargetSpec {
  return {
    uid: typeof args.uid === 'string' ? args.uid : undefined,
    selector: typeof args.selector === 'string' ? args.selector : undefined,
    x: typeof args.x === 'number' ? args.x : undefined,
    y: typeof args.y === 'number' ? args.y : undefined,
  }
}

interface ParentInfo {
  layout: string
  text?: string
}

/** Own display + parent display/uid via one in-page hop. Best-effort. */
async function layoutAndText(
  ctx: ToolContext,
  backendNodeId: number,
  selfDisplay: string,
): Promise<ParentInfo> {
  let layout = selfDisplay
  let text: string | undefined
  try {
    const { object } = await ctx.cdp.send('DOM.resolveNode', { backendNodeId, objectGroup: OBJECT_GROUP })
    if (!object.objectId) return { layout }
    const textRes = await ctx.cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration:
        'function () { return ((this.innerText || this.textContent || "").trim().replace(/\\s+/g, " ")).slice(0, 40) }',
      returnByValue: true,
    })
    if (typeof textRes.result.value === 'string' && textRes.result.value) text = textRes.result.value
    const parentRes = await ctx.cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: 'function () { return this.parentElement }',
      objectGroup: OBJECT_GROUP,
    })
    if (parentRes.result.objectId) {
      const { node: parent } = await ctx.cdp.send('DOM.describeNode', {
        objectId: parentRes.result.objectId,
      })
      const attrs = pairAttributes(parent.attributes)
      const parentUid = ctx.uids.assign(parent.backendNodeId, {
        tag: parent.nodeName.toLowerCase(),
        classes: (attrs.get('class') ?? '').split(/\s+/).filter(Boolean),
        attrId: attrs.get('id'),
      })
      const displayRes = await ctx.cdp.send('Runtime.callFunctionOn', {
        objectId: parentRes.result.objectId,
        functionDeclaration: 'function () { return getComputedStyle(this).display }',
        returnByValue: true,
      })
      const parentDisplay = String(displayRes.result.value ?? '')
      if (parentDisplay) {
        const role = /flex/.test(parentDisplay)
          ? '; flex item'
          : /grid/.test(parentDisplay)
            ? '; grid item'
            : ''
        layout = `${selfDisplay} (parent ${parentUid}: ${parentDisplay}${role})`
      }
    }
  } catch {
    /* layout line degrades to own display */
  } finally {
    void ctx.cdp.send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => {})
  }
  return { layout, text }
}

export const inspectElementTool: ToolDef = {
  name: 'inspect_element',
  description:
    'The "what" dossier for one element: box model (content/padding/border/margin), ' +
    'whitelisted computed styles as computed → used pairs, visibility verdict with cause, ' +
    'and layout context (own + parent display). Target by uid (from page_snapshot), ' +
    'CSS selector, or viewport x+y. Use explain_styles for the "why".',
  inputSchema: {
    uid: z.string().optional().describe('Element uid from a prior page_snapshot (e.g. "e8")'),
    selector: z.string().optional().describe('CSS selector — first match is used'),
    x: z.number().optional().describe('Viewport x coordinate (use with y)'),
    y: z.number().optional().describe('Viewport y coordinate (use with x)'),
    verbose: z
      .boolean()
      .optional()
      .describe('Include all whitelisted computed properties, not just non-default ones'),
  },
  async handler(ctx, args) {
    const node = await resolveTarget(ctx, targetFromArgs(args))
    const verbose = args.verbose === true

    const box = await getBoxSummary(ctx, node)
    const { computedStyle } = await ctx.cdp.send('CSS.getComputedStyleForNode', {
      nodeId: node.nodeId,
    })
    const computedMap = new Map(computedStyle.map((p) => [p.name, p.value]))

    const alwaysKeep = new Set(['display', 'width', 'height', 'font-size', 'font-family', 'color'])
    const computed: WhatDossierInput['computed'] = []
    for (const property of COMPUTED_WHITELIST) {
      const value = computedMap.get(property)
      if (value === undefined) continue
      if (!verbose && !alwaysKeep.has(property)) {
        const droppable = DROPPABLE_DEFAULTS[property]
        if (droppable?.includes(value)) continue
      }
      let usedValue: string | undefined
      if (box && (property === 'width' || property === 'height')) {
        // Computed values from CDP are already used px for width/height in most
        // cases; surface the content-box size when it differs textually
        // (border-box sizing, transforms, fractional px).
        const used = `${property === 'width' ? box.content.width : box.content.height}px`
        if (used !== value) usedValue = used
      }
      computed.push(usedValue ? { property, value, usedValue } : { property, value })
    }

    const visibility = await assessVisibility(ctx, node)
    const { layout, text } = await layoutAndText(
      ctx,
      node.backendNodeId,
      computedMap.get('display') ?? '',
    )

    const entry = ctx.uids.get(node.uid)
    const element: ElementSummary = {
      uid: node.uid,
      tag: entry?.tag ?? '',
      classes: entry?.classes ?? [],
      attrId: entry?.attrId,
      text: text ?? entry?.textPreview,
    }

    const notes: string[] = []
    if (!box) notes.push('no box model — element is not rendered')

    const input: WhatDossierInput = {
      element,
      box,
      visibility,
      computed,
      layout,
      notes: notes.length > 0 ? notes : undefined,
    }
    return { text: renderWhatDossier(input) }
  },
}
