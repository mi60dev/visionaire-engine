/**
 * evaluate — the explicit escape hatch. Runs agent-authored JavaScript in the
 * page and returns the JSON result. Field-report ask #4: every custom
 * measurement or state-forcing that the purpose-built tools don't cover used to
 * send the user out to raw CDP; this tool keeps them inside visionaire.
 *
 * The JS here is TRUSTED (the calling agent wrote it), which is the opposite of
 * page-derived text elsewhere in the engine — so the result is NOT run through
 * sanitizePageText (the agent asked for this data deliberately). It IS size-capped.
 *
 * Empirical CDP behavior this module is built around (verified against headless
 * Chrome, 2026-07-03):
 *   • A bare object literal `{ a: 1 }` parses as a *block*, so it evaluates to
 *     its last statement (1), not the object. Wrapping it as `({ a: 1 })` fixes
 *     that — but the same wrapping turns a genuine multi-statement block into a
 *     SyntaxError, so we wrap-first-then-fall-back-to-raw only for braced input.
 *   • returnByValue:true strips subtype/className/description and collapses a DOM
 *     node, a Map, and a genuine {} all to `{ type:'object', value:{} }` — there
 *     is no in-band signal to tell serializable from non-serializable. So we
 *     evaluate with returnByValue:false first to read the RemoteObject's shape,
 *     then serialize only the kinds that JSON round-trips, and describe the rest.
 *   • The CDP call itself throws (not exceptionDetails) on a timeout
 *     ("Internal error") and on deeply self-referential objects like `window`
 *     ("Object reference chain is too long"). Both are caught.
 */
import { z } from 'zod'
import type { Protocol } from 'puppeteer-core'
import type { ToolContext, ToolDef, ToolResult } from '../types.js'

const OBJECT_GROUP = 'visionaire-evaluate'

const DEFAULT_TIMEOUT_MS = 5000
const MIN_TIMEOUT_MS = 100
const MAX_TIMEOUT_MS = 30_000
/** Cap on the serialized result string. ~6000 chars ≈ 1500 tokens. */
const MAX_RESULT_CHARS = 6000

const inputSchema = {
  expression: z
    .string()
    .describe(
      'JavaScript evaluated in the page (top-level frame). May be an expression ' +
        '(e.g. "getComputedStyle(document.body).zoom"), a bare object literal ' +
        '(e.g. "{ w: innerWidth, h: innerHeight }"), or an IIFE for multi-step logic. ' +
        'The value it produces is returned as JSON.',
    ),
  awaitPromise: z
    .boolean()
    .optional()
    .describe('If the expression yields a Promise, await it and return the resolved value (default true).'),
  timeoutMs: z
    .number()
    .optional()
    .describe(`Max run time in ms before aborting (default ${DEFAULT_TIMEOUT_MS}, clamped ${MIN_TIMEOUT_MS}..${MAX_TIMEOUT_MS}).`),
}

const argsSchema = z.object(inputSchema)

/** Subtypes/kinds that don't JSON round-trip — describe them instead of serializing. */
const DESCRIBE_SUBTYPES = new Set<string>([
  'node',
  'regexp',
  'date',
  'map',
  'set',
  'weakmap',
  'weakset',
  'iterator',
  'generator',
  'error',
  'proxy',
  'promise',
  'typedarray',
  'arraybuffer',
  'dataview',
  'webassemblymemory',
  'wasmvalue',
])

function clampTimeout(ms: unknown): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return DEFAULT_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(ms)))
}

/** First line of the cleanest available error string for a thrown/rejected expression. */
function exceptionMessage(details: Protocol.Runtime.ExceptionDetails): string {
  const raw = details.exception?.description ?? details.exception?.value ?? details.text
  return String(raw ?? 'evaluation failed').split('\n')[0]!.trim()
}

/** Turn a CDP transport throw into a caller-actionable one-liner. */
function cdpThrowMessage(err: unknown, timeoutMs: number): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/Internal error/i.test(msg)) {
    return `evaluation aborted after ${timeoutMs}ms (timeout, or the page's JS is blocked)`
  }
  if (/reference chain is too long/i.test(msg)) {
    return 'result is too deeply self-referential to serialize (e.g. window/document) — return a specific projection of it instead'
  }
  return `evaluation could not run: ${msg}`
}

function isError(result: string): ToolResult {
  // isError-style: the message travels as the result text, never as a throw that
  // would strip it. Callers see the failure without losing the CDP message.
  return { text: `evaluate error: ${result}` }
}

function capResult(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text
  const kept = text.slice(0, MAX_RESULT_CHARS)
  return `${kept}\n… [truncated: result was ${text.length} chars, capped at ${MAX_RESULT_CHARS}. Return a smaller projection.]`
}

/** Describe a non-serializable RemoteObject from its rbv:false shape. */
function describeRemote(obj: Protocol.Runtime.RemoteObject): string {
  const kind = obj.subtype ?? obj.type
  const parts: string[] = [kind]
  if (obj.className && obj.className !== kind) parts.push(obj.className)
  const label = parts.join(' ')
  const desc = obj.description ? ` — ${obj.description.split('\n')[0]}` : ''
  return `[non-serializable ${label}${desc}]`
}

export const evaluateTool: ToolDef = {
  name: 'evaluate',
  description:
    'ESCAPE HATCH — run arbitrary JavaScript in the page and get the JSON result. ' +
    'Use ONLY when no purpose-built tool covers the need: a custom measurement, ' +
    'forcing a UI state (dispatch an event, toggle a class), or reading ' +
    'framework/component state. Prefer explain_styles / measure_element / ' +
    'inspect_element / interact where they apply. The expression may be an ' +
    'expression, a bare object literal, or an IIFE. The JS is agent-authored ' +
    '(trusted) — its result is returned verbatim, not sanitized as page text — ' +
    'and is size-capped.',
  inputSchema,
  handler: async (ctx, args): Promise<ToolResult> => {
    const a = argsSchema.parse(args)
    const expression = a.expression
    const awaitPromise = a.awaitPromise ?? true
    const timeoutMs = clampTimeout(a.timeoutMs)

    const trimmed = expression.trim()
    if (!trimmed) throw new Error('expression is empty — provide JavaScript to run in the page.')
    const looksBraced = trimmed.startsWith('{') && trimmed.endsWith('}')

    try {
      // Pass 1: returnByValue:false to read the RemoteObject's true shape.
      let source = looksBraced ? `(${trimmed})` : expression
      let meta: Protocol.Runtime.EvaluateResponse
      try {
        meta = (await ctx.cdp.send('Runtime.evaluate', {
          expression: source,
          returnByValue: false,
          awaitPromise,
          timeout: timeoutMs,
          objectGroup: OBJECT_GROUP,
        })) as Protocol.Runtime.EvaluateResponse
      } catch (err) {
        return isError(cdpThrowMessage(err, timeoutMs))
      }

      // Wrapping a genuine multi-statement block in parens is a SyntaxError —
      // retry the raw source so blocks-with-a-trailing-expression still work.
      if (
        looksBraced &&
        meta.exceptionDetails &&
        meta.exceptionDetails.exception?.className === 'SyntaxError'
      ) {
        source = expression
        try {
          meta = (await ctx.cdp.send('Runtime.evaluate', {
            expression: source,
            returnByValue: false,
            awaitPromise,
            timeout: timeoutMs,
            objectGroup: OBJECT_GROUP,
          })) as Protocol.Runtime.EvaluateResponse
        } catch (err) {
          return isError(cdpThrowMessage(err, timeoutMs))
        }
      }

      if (meta.exceptionDetails) {
        return isError(exceptionMessage(meta.exceptionDetails))
      }

      const obj = meta.result

      // Primitives and null carry their value directly on the rbv:false result.
      switch (obj.type) {
        case 'undefined':
          return { text: 'undefined' }
        case 'string':
          return { text: capResult(JSON.stringify(obj.value)) }
        case 'boolean':
          return { text: capResult(String(obj.value)) }
        case 'number':
          // BigInt-as-number never happens; Infinity/NaN arrive via unserializableValue.
          if (obj.unserializableValue !== undefined) return { text: String(obj.unserializableValue) }
          return { text: capResult(String(obj.value)) }
        case 'bigint':
          return { text: obj.unserializableValue ?? obj.description ?? 'bigint' }
        case 'symbol':
          return { text: obj.description ?? 'symbol' }
        case 'function':
          return { text: describeRemote(obj) }
        case 'object': {
          if (obj.subtype === 'null') return { text: 'null' }
          // Special objects that don't JSON round-trip: describe, don't serialize.
          if (obj.subtype && DESCRIBE_SUBTYPES.has(obj.subtype)) {
            return { text: describeRemote(obj) }
          }
          // Plain object / array: serialize by value. This can still throw on the
          // wire (deeply self-referential) — catch and fall back to a description.
          try {
            const byValue = (await ctx.cdp.send('Runtime.evaluate', {
              expression: source,
              returnByValue: true,
              awaitPromise,
              timeout: timeoutMs,
            })) as Protocol.Runtime.EvaluateResponse
            if (byValue.exceptionDetails) return isError(exceptionMessage(byValue.exceptionDetails))
            const json = JSON.stringify(byValue.result.value)
            // JSON.stringify returns undefined for a value it can't represent
            // (e.g. an object graph of only functions); fall back to a description.
            if (json === undefined) return { text: describeRemote(obj) }
            return { text: capResult(json) }
          } catch {
            return { text: describeRemote(obj) }
          }
        }
        default:
          return { text: describeRemote(obj) }
      }
    } finally {
      await ctx.cdp.send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => {})
    }
  },
}
