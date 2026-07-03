/**
 * inject_css — the live fix loop. Apply CSS to the page WITHOUT touching source
 * files: try a candidate fix, see what actually changed, converge, then write
 * the final declarations into the source once. Patches are trial-only — they
 * live in injected <style> tags, vanish on navigation, and are revertable.
 *
 * Field-report origin: "to test my fix I had to edit the file → cache-bust →
 * restart Chrome → reload → re-snapshot, repeated ~4 times."
 */
import { z } from 'zod'
import type { ToolContext, ToolDef } from '../types.js'
import { COMPUTED_WHITELIST } from '../types.js'
import { resolveTarget } from '../uid.js'

const PATCH_ATTR = 'data-visionaire-patch'
const STYLE_ID_PREFIX = 'visionaire-patch-'

// Server-process-lifetime counter; ids stay unique across navigations.
let patchCounter = 0

const inputSchema = {
  uid: z.string().optional().describe('Element uid to patch (from page_snapshot / find_elements)'),
  selector: z.string().optional().describe('CSS selector (first match) — alternative to uid'),
  declarations: z
    .string()
    .optional()
    .describe(
      'Declarations to trial on the target, e.g. "align-items: center; margin-top: 4px". ' +
        'Applied with !important so the trial always wins; requires uid or selector.',
    ),
  css: z
    .string()
    .optional()
    .describe('Raw CSS rule block(s) to inject page-wide, e.g. ".onetrust-banner { display: none }"'),
  revert: z
    .string()
    .optional()
    .describe("Remove a previous patch by id (e.g. 'p2'), or 'all' to remove every patch"),
}

/** "a: b; c: d" → "a: b !important; c: d !important" (existing !important kept). */
function importantify(declarations: string): string {
  return declarations
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => (/!\s*important$/i.test(d) ? d : `${d} !important`))
    .join('; ')
}

async function computedFor(ctx: ToolContext, nodeId: number): Promise<Map<string, string>> {
  const { computedStyle } = await ctx.cdp.send('CSS.getComputedStyleForNode', { nodeId })
  const map = new Map<string, string>()
  const wanted = new Set<string>(COMPUTED_WHITELIST)
  for (const p of computedStyle) if (wanted.has(p.name)) map.set(p.name, p.value)
  return map
}

async function inPage(ctx: ToolContext, expression: string): Promise<unknown> {
  const { result, exceptionDetails } = await ctx.cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
  })
  if (exceptionDetails) {
    throw new Error(`inject_css in-page step failed: ${exceptionDetails.exception?.description?.split('\n')[0] ?? exceptionDetails.text}`)
  }
  return result.value
}

const GUIDANCE =
  'This is a LIVE TRIAL only — the source is untouched and the patch vanishes on navigation. ' +
  'When it looks right (verify with measure_element / style_diff / annotated_screenshot), write the final ' +
  "declarations into the winning rule (explain_styles names its file:line), then revert: 'all'."

export const injectCssTool: ToolDef = {
  name: 'inject_css',
  description:
    'Apply CSS to the live page without touching source files — trial a fix, hide an overlay, converge, then edit source once.',
  inputSchema,
  async handler(ctx, args) {
    const declarations = typeof args.declarations === 'string' ? args.declarations.trim() : ''
    const rawCss = typeof args.css === 'string' ? args.css.trim() : ''
    const revert = typeof args.revert === 'string' ? args.revert.trim() : ''
    const hasTarget = typeof args.uid === 'string' || typeof args.selector === 'string'

    const modes = [declarations ? 1 : 0, rawCss ? 1 : 0, revert ? 1 : 0].reduce((a, b) => a + b, 0)
    if (modes !== 1) {
      throw new Error(
        "Provide exactly one of: declarations (+ uid/selector), css, or revert ('all' or a patch id like 'p2').",
      )
    }

    // ── revert ──
    if (revert) {
      const removed = (await inPage(
        ctx,
        revert === 'all'
          ? `(() => {
              const tags = document.querySelectorAll('style[id^="${STYLE_ID_PREFIX}"]');
              const n = tags.length;
              tags.forEach((t) => t.remove());
              document.querySelectorAll('[${PATCH_ATTR}]').forEach((el) => el.removeAttribute('${PATCH_ATTR}'));
              return n;
            })()`
          : `(() => {
              const t = document.getElementById('${STYLE_ID_PREFIX}${revert}');
              if (!t) return 0;
              t.remove();
              document.querySelectorAll('[${PATCH_ATTR}~="${revert}"]').forEach((el) => {
                const rest = (el.getAttribute('${PATCH_ATTR}') || '').split(/\\s+/).filter((x) => x && x !== '${revert}');
                if (rest.length) el.setAttribute('${PATCH_ATTR}', rest.join(' '));
                else el.removeAttribute('${PATCH_ATTR}');
              });
              return 1;
            })()`,
      )) as number
      return {
        text:
          removed > 0
            ? `reverted ${revert === 'all' ? `${removed} patch(es)` : revert} — the page is back to its served CSS.`
            : `nothing to revert (${revert === 'all' ? 'no active patches' : `no patch "${revert}"`}).`,
      }
    }

    const patchId = `p${++patchCounter}`

    // ── raw page-wide CSS ──
    if (rawCss) {
      await inPage(
        ctx,
        `(() => {
          const s = document.createElement('style');
          s.id = ${JSON.stringify(STYLE_ID_PREFIX + patchId)};
          s.textContent = ${JSON.stringify(rawCss)};
          document.head.appendChild(s);
        })()`,
      )
      return {
        text:
          `patch ${patchId} injected (page-wide rule block, ${rawCss.length} chars). ` +
          `Re-inspect to see the effect. ${GUIDANCE}`,
      }
    }

    // ── targeted declarations trial ──
    if (!hasTarget) {
      throw new Error('declarations need a target — pass uid or selector for the element to patch.')
    }
    const node = await resolveTarget(ctx, {
      uid: typeof args.uid === 'string' ? args.uid : undefined,
      selector: typeof args.selector === 'string' ? args.selector : undefined,
    })

    const before = await computedFor(ctx, node.nodeId)

    const ruleBody = importantify(declarations)
    const { object } = await ctx.cdp.send('DOM.resolveNode', { backendNodeId: node.backendNodeId })
    if (!object.objectId) throw new Error('could not resolve the target element in-page.')
    await ctx.cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function (attr, id, cssText, styleIdPrefix) {
        const tokens = (this.getAttribute(attr) || '').split(/\\s+/).filter(Boolean);
        tokens.push(id);
        this.setAttribute(attr, tokens.join(' '));
        const s = document.createElement('style');
        s.id = styleIdPrefix + id;
        s.textContent = '[' + attr + '~="' + id + '"] { ' + cssText + ' }';
        document.head.appendChild(s);
      }`,
      arguments: [
        { value: PATCH_ATTR },
        { value: patchId },
        { value: ruleBody },
        { value: STYLE_ID_PREFIX },
      ],
    })

    // Give the engine a beat to recalc styles before diffing.
    await new Promise((r) => setTimeout(r, 60))
    const after = await computedFor(ctx, node.nodeId)

    const changes: string[] = []
    for (const [prop, newVal] of after) {
      const oldVal = before.get(prop)
      if (oldVal !== undefined && oldVal !== newVal) changes.push(`  ${prop}: ${oldVal} → ${newVal}`)
    }

    const entry = ctx.uids.get(node.uid)
    const identity = `${node.uid} <${entry?.tag ?? ''}${entry?.attrId ? `#${entry.attrId}` : ''}${(entry?.classes ?? [])
      .slice(0, 3)
      .map((c) => `.${c}`)
      .join('')}>`
    const header = `patch ${patchId} applied to ${identity}: ${ruleBody}`
    const effect =
      changes.length > 0
        ? `computed changes:\n${changes.join('\n')}`
        : 'no whitelisted computed property changed — the declarations may target properties outside the layout ' +
          'whitelist, or be losing to an even stronger rule (run explain_styles on the property to see the winner).'
    return { text: `${header}\n${effect}\n${GUIDANCE}` }
  },
}
