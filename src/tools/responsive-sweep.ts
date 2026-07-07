/**
 * responsive_sweep — one verification payload, many viewports (v-next SPEC §3F).
 * Runs a stored suite, inline assertions, or a diagnose probe at each viewport
 * and returns a compact matrix: PASS cells collapse to a verdict, FAIL cells
 * carry the measured actuals, diagnose cells carry the detected symptom and top
 * culprit. "Fixed on desktop, still broken on mobile" becomes one call.
 *
 * Determinism: after every viewport change the page is settled (fonts.ready +
 * double requestAnimationFrame) before measuring, and suites are re-loaded per
 * viewport so stored selectors re-resolve against each layout. The original
 * viewport is restored in a finally (unless restore_viewport:false or attach
 * mode, where puppeteer reports no viewport to restore).
 */
import { z } from 'zod'
import type { ToolContext, ToolDef, ToolResult } from '../types.js'
import { sanitizePageText } from '../types.js'
import type { AssertionSpec } from '../engine/assert.js'
import type { DiagnoseInput } from '../engine/diagnose.js'
import { runSuiteOrAssertions } from './assert-visual.js'
import { assertionSchema } from './assertion-schema.js'
import { listSuites, loadSuite } from '../store/suites.js'
import { markVerified } from '../store/verify-marker.js'

/** Keep the envelope comfortably under the ~15KB transport floor (v-next SPEC §7). */
const MAX_RESPONSE_BYTES = Math.max(4_000, Number(process.env['VISIONAIRE_MAX_RESPONSE_KB']) * 1024 || 15_000)

const MAX_VIEWPORTS = 8

const DEFAULT_VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
]

const viewportSchema = z.object({
  width: z.number().int().min(1).max(10_000).describe('Viewport width in CSS px'),
  height: z.number().int().min(1).max(10_000).describe('Viewport height in CSS px'),
  deviceScaleFactor: z.number().min(0.25).max(5).optional().describe('Device pixel ratio (default 1)'),
})

const diagnoseSchema = z.object({
  target: z
    .object({
      uid: z.string().optional().describe('Element uid from a prior page_snapshot (e.g. "e8")'),
      selector: z.string().optional().describe('CSS selector — first match is used'),
      x: z.number().optional().describe('Viewport x coordinate (use with y)'),
      y: z.number().optional().describe('Viewport y coordinate (use with x)'),
    })
    .describe('Element to diagnose at each viewport (uid | selector | x+y)'),
  symptom: z
    .enum(['clipped', 'overflowing', 'not_centered', 'invisible', 'overlapping', 'wrong_size', 'auto'])
    .optional()
    .describe("What looks wrong; 'auto' (default) detects the symptom from the rendered facts"),
  expected: z
    .object({
      width_px: z.number().optional().describe('Expected width in CSS px'),
      height_px: z.number().optional().describe('Expected height in CSS px'),
      centered_in: z.enum(['parent', 'viewport']).optional().describe('Expected centering reference'),
    })
    .optional()
    .describe('Expected geometry, for wrong_size / not_centered symptoms'),
  max_culprits: z.number().int().min(1).max(10).optional().describe('Cap on ranked culprits per viewport'),
})

const inputSchema = {
  viewports: z
    .array(viewportSchema)
    .min(1)
    .default(DEFAULT_VIEWPORTS)
    .describe(
      `Viewports to sweep, max ${MAX_VIEWPORTS} per call ` +
        '(default: 375x812, 768x1024, 1280x800, 1920x1080)',
    ),
  run: z
    .object({
      suite_id: z
        .string()
        .optional()
        .describe('Re-run this stored assertion suite at each viewport (selectors re-resolve per viewport)'),
      assertions: z
        .array(assertionSchema)
        .min(1)
        .max(100)
        .optional()
        .describe('Inline assertions to evaluate at each viewport'),
      diagnose: diagnoseSchema.optional().describe('Diagnose one element at each viewport instead of asserting'),
    })
    .describe('The payload to execute at every viewport — exactly ONE of suite_id | assertions | diagnose'),
  restore_viewport: z.boolean().default(true).describe('Restore the pre-sweep viewport when done (default true)'),
}

const argsSchema = z.object(inputSchema)

interface FailedAssertion {
  id?: string
  type: string
  measured?: Record<string, unknown>
  offending_uids?: string[]
  /** Per-assertion error code when that assertion ERRORed inside a FAIL cell. */
  error?: string
}

interface SweepCell {
  viewport: string
  verdict?: 'PASS' | 'FAIL' | 'ERROR'
  failed?: FailedAssertion[]
  /** Cell-level error: the payload could not run at this viewport at all. */
  error?: string
  symptom_detected?: string
  top_culprit?: { cause: string; plain: string }
}

interface Envelope {
  summary: string
  matrix: SweepCell[]
  truncated: boolean
}

/**
 * Deterministic settle after a viewport change: fonts loaded, then two animation
 * frames so layout/paint for the new size has actually happened before measuring.
 */
const SETTLE_EXPRESSION =
  '(async () => { if (document.fonts && document.fonts.ready) await document.fonts.ready; ' +
  'await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); })()'

async function settle(ctx: ToolContext): Promise<void> {
  await ctx.cdp.send('Runtime.evaluate', {
    expression: SETTLE_EXPRESSION,
    awaitPromise: true,
    returnByValue: true,
  })
}

type RunPayload = z.infer<typeof argsSchema>['run']

async function runCell(ctx: ToolContext, run: RunPayload, viewport: string): Promise<SweepCell> {
  if (run.diagnose) {
    // Lazy import: diagnose is only loaded when a diagnose payload runs, so
    // assertion sweeps have no dependency on the diagnose engine.
    const { runDiagnose } = await import('../engine/diagnose.js')
    const input: DiagnoseInput = { target: run.diagnose.target }
    if (run.diagnose.symptom !== undefined) input.symptom = run.diagnose.symptom
    if (run.diagnose.expected !== undefined) input.expected = run.diagnose.expected
    if (run.diagnose.max_culprits !== undefined) input.max_culprits = run.diagnose.max_culprits
    const report = await runDiagnose(ctx, input)
    const cell: SweepCell = { viewport, symptom_detected: report.symptom_detected }
    const top = report.culprits[0]
    if (top) cell.top_culprit = { cause: top.cause, plain: top.plain }
    return cell
  }

  const payload =
    run.suite_id !== undefined ? { suite_id: run.suite_id } : { assertions: run.assertions as AssertionSpec[] }
  const { results, verdict } = await runSuiteOrAssertions(ctx, payload)
  if (verdict === 'PASS') return { viewport, verdict: 'PASS' }

  // FAIL cells carry the numbers that prove it — never the prose explanations.
  const failed: FailedAssertion[] = results
    .filter((r) => r.verdict !== 'PASS')
    .map((r) => {
      const row: FailedAssertion = { type: r.type }
      if (r.id !== undefined) row.id = r.id
      if (r.measured !== undefined) row.measured = r.measured
      if (r.offending_uids !== undefined) row.offending_uids = r.offending_uids
      if (r.error !== undefined) row.error = r.error
      return row
    })
  return { viewport, verdict: 'FAIL', failed }
}

function buildSummary(label: string, cells: SweepCell[], isDiagnose: boolean): string {
  if (isDiagnose) {
    const parts = cells.map((c) =>
      c.verdict === 'ERROR' ? `ERROR at ${c.viewport}` : `${c.symptom_detected ?? 'none'} at ${c.viewport}`,
    )
    return `${label}: ${parts.join('; ')}`
  }
  const parts: string[] = []
  const passes = cells.filter((c) => c.verdict === 'PASS').map((c) => c.viewport)
  if (passes.length > 0) parts.push(`PASS at ${passes.join('/')}`)
  for (const c of cells) {
    if (c.verdict !== 'FAIL') continue
    const types = [...new Set((c.failed ?? []).map((f) => f.type))]
    parts.push(`FAIL at ${c.viewport}${types.length > 0 ? ` (${types.join(', ')})` : ''}`)
  }
  const errors = cells.filter((c) => c.verdict === 'ERROR').map((c) => c.viewport)
  if (errors.length > 0) parts.push(`ERROR at ${errors.join('/')}`)
  return `${label}: ${parts.join('; ')}`
}

function renderEnvelope(summary: string, cells: SweepCell[], cap: number): Envelope {
  let truncated = false
  const matrix = cells.map((c) => {
    if (!c.failed || c.failed.length <= cap) return c
    truncated = true
    return { ...c, failed: c.failed.slice(0, cap) }
  })
  return { summary, matrix, truncated }
}

export const responsiveSweepTool: ToolDef = {
  name: 'responsive_sweep',
  description:
    'Run one verification payload across several viewports in a single call: a stored assertion suite, ' +
    'inline assertions, or a diagnose probe. Returns a per-viewport matrix — PASS cells collapse, FAIL cells ' +
    'carry measured actuals and offending uids, diagnose cells carry the detected symptom and top culprit — ' +
    'so "fixed on desktop, still broken on mobile" is caught before claiming success. Restores the original ' +
    'viewport afterwards.',
  inputSchema,
  async handler(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const a = argsSchema.parse(args)

    if (a.viewports.length > MAX_VIEWPORTS) {
      throw new Error(
        `too many viewports (${a.viewports.length}) — max ${MAX_VIEWPORTS} per call; ` +
          'split the sweep into multiple calls with fewer viewports each',
      )
    }

    const chosen = [a.run.suite_id !== undefined, a.run.assertions !== undefined, a.run.diagnose !== undefined]
    if (chosen.filter(Boolean).length !== 1) {
      throw new Error(
        'run must carry exactly one payload: {suite_id} to re-run a stored suite, {assertions} for inline ' +
          'checks, or {diagnose} to probe one element per viewport',
      )
    }

    // Unknown suite fails fast — before any viewport churn. The per-viewport calls
    // still re-load the suite so stored selectors re-resolve at EACH viewport.
    if (a.run.suite_id !== undefined && loadSuite(a.run.suite_id) === undefined) {
      const known = listSuites()
      throw new Error(
        `SUITE_NOT_FOUND: no suite named "${a.run.suite_id}".` +
          (known.length > 0 ? ` Known suites: ${known.join(', ')}.` : ' No suites registered yet.') +
          ' Register one by calling assert_visual with both assertions and suite_id.',
      )
    }

    const original = ctx.page.viewport()
    const cells: SweepCell[] = []
    let restoreNote = ''
    try {
      for (const vp of a.viewports) {
        const label = `${vp.width}x${vp.height}`
        try {
          await ctx.page.setViewport({
            width: vp.width,
            height: vp.height,
            deviceScaleFactor: vp.deviceScaleFactor ?? 1,
          })
          await settle(ctx)
          cells.push(await runCell(ctx, a.run, label))
        } catch (err) {
          // One broken viewport must not abort the sweep — record and continue.
          const msg = err instanceof Error ? err.message : String(err)
          cells.push({ viewport: label, verdict: 'ERROR', error: sanitizePageText(msg, 200) })
        }
      }
    } finally {
      if (a.restore_viewport) {
        if (original) {
          try {
            await ctx.page.setViewport(original)
            await settle(ctx)
          } catch (err) {
            console.error(
              '[visionaire] responsive_sweep could not restore the viewport:',
              err instanceof Error ? err.message : err,
            )
            restoreNote = ' — viewport restore failed; call set_viewport to fix it'
          }
        } else {
          // Attach mode: puppeteer reports no viewport, so there is nothing to restore to.
          restoreNote = ' — viewport not restored (attach mode)'
        }
      }
    }

    // A verification pass RAN across the matrix — record it for the Stop-hook gate.
    markVerified('responsive_sweep')

    const label =
      a.run.suite_id !== undefined
        ? `Suite '${a.run.suite_id}'`
        : a.run.assertions !== undefined
          ? 'Assertions'
          : 'Diagnose'
    const summary = buildSummary(label, cells, a.run.diagnose !== undefined) + restoreNote

    // Byte-budget backstop: trim FAIL cells' failed lists until the envelope fits.
    let cap = Math.max(1, ...cells.map((c) => c.failed?.length ?? 0))
    let envelope = renderEnvelope(summary, cells, cap)
    while (JSON.stringify(envelope, null, 1).length > MAX_RESPONSE_BYTES && cap > 1) {
      cap = Math.floor(cap / 2)
      envelope = renderEnvelope(summary, cells, cap)
    }

    return { text: JSON.stringify(envelope, null, 1) }
  },
}
