/**
 * diagnose — one-shot "why is this broken" (v-next SPEC §3E). Runs the
 * deterministic symptom battery from src/engine/diagnose.ts against one target
 * element and returns ranked culprits with measured pixel evidence in a compact
 * JSON envelope: { summary, symptom_detected, culprits, truncated }.
 */
import { z } from 'zod'
import type { ToolContext, ToolDef, ToolResult } from '../types.js'
import { runDiagnose, type DiagnoseInput, type DiagnoseReport } from '../engine/diagnose.js'

/** This tool's envelope stays small by design (spec: < 6KB), inside the global cap. */
const MAX_RESPONSE_BYTES = Math.max(4_000, Number(process.env['VISIONAIRE_MAX_RESPONSE_KB']) * 1024 || 15_000)
const ENVELOPE_BUDGET_BYTES = Math.min(6_000, MAX_RESPONSE_BYTES)

const inputSchema = {
  uid: z.string().optional().describe('Element uid from a prior page_snapshot / find_elements'),
  selector: z.string().optional().describe('CSS selector (first match) — alternative to uid'),
  x: z.number().optional().describe('Viewport x coordinate — use together with y'),
  y: z.number().optional().describe('Viewport y coordinate — use together with x'),
  symptom: z
    .enum(['clipped', 'overflowing', 'not_centered', 'invisible', 'overlapping', 'wrong_size', 'auto'])
    .default('auto')
    .describe(
      "What looks broken; 'auto' runs the ordered battery invisible → clipped → overflowing → overlapping → not_centered",
    ),
  expected: z
    .object({
      width_px: z.number().optional().describe('Expected content-box width in CSS px (wrong_size)'),
      height_px: z.number().optional().describe('Expected content-box height in CSS px (wrong_size)'),
      centered_in: z
        .enum(['parent', 'viewport'])
        .optional()
        .describe("Centering container for not_centered (default 'parent')"),
    })
    .optional()
    .describe('What the element SHOULD look like — required for wrong_size'),
  max_culprits: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(5)
    .describe('Cap on ranked culprits returned (default 5)'),
}

const argsSchema = z.object(inputSchema)

export const diagnoseTool: ToolDef = {
  name: 'diagnose',
  description:
    'One-shot "why does this element look broken" — deterministic ranked culprits with measured pixel ' +
    'evidence for clipping, overflow, off-center layout, invisibility, overlap, and wrong size. ' +
    "Point it at one element (uid/selector/x,y); default symptom 'auto' finds the first tripped check.",
  inputSchema,
  async handler(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const a = argsSchema.parse(args)
    if ((a.x === undefined) !== (a.y === undefined)) {
      throw new Error('provide x and y together to target by coordinates')
    }

    const input: DiagnoseInput = {
      target: { uid: a.uid, selector: a.selector, x: a.x, y: a.y },
      symptom: a.symptom,
      max_culprits: a.max_culprits,
    }
    if (a.expected !== undefined) input.expected = a.expected

    const report = await runDiagnose(ctx, input)

    // Byte-budget backstop: drop trailing (lowest-ranked) culprits until it fits.
    const envelope: DiagnoseReport = {
      ...report,
      culprits: [...report.culprits],
    }
    while (JSON.stringify(envelope, null, 1).length > ENVELOPE_BUDGET_BYTES && envelope.culprits.length > 1) {
      envelope.culprits.pop()
      envelope.truncated = true
    }

    return { text: JSON.stringify(envelope, null, 1) }
  },
}
