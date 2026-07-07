/**
 * assert_visual — the verification gate (v-next SPEC §3A). The agent states
 * verifiable rendered-geometry claims; this returns a deterministic per-assertion
 * PASS/FAIL with measured actuals and offending uids, so "now they are equal
 * height" can never be claimed without the numbers to prove it.
 *
 * With suite_id + assertions: registers the suite, runs it. With suite_id only:
 * re-runs the stored suite against the CURRENT render (the harness calls this
 * after every edit). Output is a compact JSON envelope (v-next convention) —
 * verdict, summary, results[] — never screenshots, never more than the caller's
 * page of results.
 */
import { z } from 'zod'
import type { ToolContext, ToolDef, ToolResult } from '../types.js'
import {
  overallVerdict,
  summarize,
  type AssertionResult,
  type AssertionSpec,
} from '../engine/assert.js'
import { runAssertions } from '../engine/assert-collect.js'
import { assertionSchema } from './assertion-schema.js'
import { loadSuite, saveSuite, listSuites } from '../store/suites.js'
import { markVerified } from '../store/verify-marker.js'

/** Keep the envelope comfortably under the ~15KB transport floor (v-next SPEC §7). */
const MAX_RESPONSE_BYTES = Math.max(4_000, Number(process.env['VISIONAIRE_MAX_RESPONSE_KB']) * 1024 || 15_000)

const inputSchema = {
  assertions: z
    .array(assertionSchema)
    .min(1)
    .max(100)
    .optional()
    .describe('Assertions to evaluate; omit to re-run a stored suite_id'),
  suite_id: z
    .string()
    .optional()
    .describe('Name this assertion set as a re-runnable suite; alone (no assertions) re-runs the stored suite'),
  tolerance_px: z.number().min(0).max(100).default(1).describe('Global edge/size tolerance in CSS px (default 1)'),
  detail: z.enum(['summary', 'full']).default('summary').describe("'full' adds per-assertion explanations"),
  stop_on_first_fail: z.boolean().default(false).describe('Stop evaluating after the first FAIL/ERROR'),
  page: z
    .object({
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(50),
    })
    .optional()
    .describe('Paginate the results array of a large suite'),
}

const argsSchema = z.object(inputSchema)

interface Envelope {
  verdict: 'PASS' | 'FAIL'
  summary: string
  results: AssertionResult[]
  suite_id?: string
  truncated: boolean
  next_offset?: number
}

export const assertVisualTool: ToolDef = {
  name: 'assert_visual',
  description:
    'Deterministic PASS/FAIL verdicts for rendered-geometry claims — equal heights, alignment, centering, gaps, ' +
    'overlap, clipping, colors, z-order — with measured pixel actuals and offending uids. ' +
    'State your claim as assertions after every visual edit; register a suite_id to re-run the same checks later.',
  inputSchema,
  async handler(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const a = argsSchema.parse(args)

    let specs: AssertionSpec[]
    let suiteNote = ''
    if (a.assertions && a.assertions.length > 0) {
      specs = a.assertions as AssertionSpec[]
      if (a.suite_id !== undefined) {
        saveSuite(a.suite_id, specs)
        suiteNote = ` — registered as suite '${a.suite_id}' (re-run with just {"suite_id":"${a.suite_id}"})`
      }
    } else if (a.suite_id !== undefined) {
      const stored = loadSuite(a.suite_id)
      if (!stored) {
        const known = listSuites()
        throw new Error(
          `SUITE_NOT_FOUND: no suite named "${a.suite_id}".` +
            (known.length > 0 ? ` Known suites: ${known.join(', ')}.` : ' No suites registered yet.') +
            ' Register one by calling assert_visual with both assertions and suite_id.',
        )
      }
      specs = stored
    } else {
      throw new Error('Provide assertions (optionally with suite_id to register them), or suite_id alone to re-run a stored suite.')
    }

    const { results, skipped } = await runAssertions(ctx, specs, {
      tolerancePx: a.tolerance_px,
      stopOnFirstFail: a.stop_on_first_fail,
    })

    // A verification pass RAN (pass or fail) — record it for the Stop-hook gate.
    markVerified('assert_visual')

    const verdict = skipped > 0 ? 'FAIL' : overallVerdict(results)
    let summary = summarize(results)
    if (skipped > 0) summary += ` (stopped after first failure — ${skipped} not evaluated)`
    summary += suiteNote

    // Detail tier: summary drops explanations (measured numbers stay — they ARE the verdict).
    const rendered = results.map((r) => {
      if (a.detail === 'full') return r
      const { explanation: _explanation, ...rest } = r
      // ERROR results keep their explanation — it is the error message.
      return r.verdict === 'ERROR' ? r : rest
    })

    // Pagination, then a byte-budget backstop.
    const offset = a.page?.offset ?? 0
    let limit = a.page?.limit ?? 50
    let pageOut = rendered.slice(offset, offset + limit)
    let envelope = build(verdict, summary, pageOut, a.suite_id, offset, rendered.length)
    while (JSON.stringify(envelope, null, 1).length > MAX_RESPONSE_BYTES && limit > 1) {
      limit = Math.max(1, Math.floor(limit / 2))
      pageOut = rendered.slice(offset, offset + limit)
      envelope = build(verdict, summary, pageOut, a.suite_id, offset, rendered.length)
    }

    return { text: JSON.stringify(envelope, null, 1) }
  },
}

function build(
  verdict: 'PASS' | 'FAIL',
  summary: string,
  page: AssertionResult[],
  suiteId: string | undefined,
  offset: number,
  total: number,
): Envelope {
  const truncated = offset + page.length < total
  const env: Envelope = { verdict, summary, results: page, truncated }
  if (suiteId !== undefined) env.suite_id = suiteId
  if (truncated) env.next_offset = offset + page.length
  return env
}

/** Re-run helper shared with responsive_sweep / capture_proof — same engine, no envelope. */
export async function runSuiteOrAssertions(
  ctx: ToolContext,
  input: { suite_id?: string; assertions?: AssertionSpec[] },
  tolerancePx?: number,
): Promise<{ results: AssertionResult[]; verdict: 'PASS' | 'FAIL' }> {
  let specs: AssertionSpec[] | undefined = input.assertions
  if (!specs || specs.length === 0) {
    if (input.suite_id === undefined) throw new Error('Provide suite_id or assertions.')
    specs = loadSuite(input.suite_id)
    if (!specs) throw new Error(`SUITE_NOT_FOUND: no suite named "${input.suite_id}".`)
  }
  const opts = tolerancePx === undefined ? {} : { tolerancePx }
  const { results } = await runAssertions(ctx, specs, opts)
  return { results, verdict: overallVerdict(results) }
}
