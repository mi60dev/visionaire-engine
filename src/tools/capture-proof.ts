/**
 * capture_proof — durable before/after evidence for one fix (v-next SPEC §3G).
 * Phase 'before' records the broken state (annotated screenshot + optional suite
 * verdicts) into a named bundle; phase 'after' re-captures and reports the
 * verdict delta against the stored before-verdicts — "suite now PASS (was
 * FAIL)" with the exact assertions that flipped. Images are written to the
 * artifacts dir and returned as FILE PATHS, never base64 (v-next §7).
 */
import { z } from 'zod'
import type { ToolContext, ToolDef, ToolResult } from '../types.js'
import { sanitizePageText } from '../types.js'
import type { AssertionResult } from '../engine/assert.js'
import { resolveAssertTarget, TargetResolutionError } from '../engine/assert-collect.js'
import { annotatedScreenshotTool } from './annotated-screenshot.js'
import { runSuiteOrAssertions } from './assert-visual.js'
import { bundleDir, hasPhase, loadPhaseVerdicts, savePhase } from '../store/bundles.js'

const MAX_TARGETS = 25

const inputSchema = {
  phase: z
    .enum(['before', 'after'])
    .describe("Which side of the fix this capture is: 'before' the edit or 'after' it"),
  bundle_id: z
    .string()
    .describe('Bundle name (1-64 chars: letters, digits, hyphens, underscores) — use the SAME id for before and after'),
  targets: z
    .array(
      z.union([
        z.string().describe('Element uid from a prior page_snapshot / find_elements'),
        z.object({ selector: z.string().describe('CSS selector') }).describe('CSS selector — expands to ALL matches'),
      ]),
    )
    .default([])
    .describe(
      `Elements to mark in the screenshot (deduped, max ${MAX_TARGETS} after selector expansion); ` +
        'empty = auto-mark the top visible interactive/landmark elements',
    ),
  suite_id: z
    .string()
    .optional()
    .describe('Run this stored assertion suite and store its verdicts with the phase (enables verdict_delta on after)'),
  note: z.string().max(500).optional().describe('Free-form caption for this capture, echoed in the summary'),
}

const argsSchema = z.object(inputSchema)

interface StoredVerdicts {
  verdict: 'PASS' | 'FAIL'
  results: AssertionResult[]
}

interface VerdictDelta {
  before: 'PASS' | 'FAIL'
  after: 'PASS' | 'FAIL'
  changed_assertions: Array<{ id: string; before: string; after: string }>
}

interface Envelope {
  summary: string
  bundle_id: string
  phase: 'before' | 'after'
  artifacts: Array<{ kind: string; path: string }>
  verdict_delta?: VerdictDelta
  warnings?: string[]
  truncated: boolean
}

/** Defensive shape-check for verdicts read back from disk (a bundle dir is user-visible state). */
function asStoredVerdicts(v: object | undefined): StoredVerdicts | undefined {
  if (v === undefined) return undefined
  const o = v as { verdict?: unknown; results?: unknown }
  if ((o.verdict === 'PASS' || o.verdict === 'FAIL') && Array.isArray(o.results)) {
    return { verdict: o.verdict, results: o.results as AssertionResult[] }
  }
  return undefined
}

/** Pair assertion results by id (falling back to array index) and list verdict flips. */
function buildDelta(before: StoredVerdicts, after: StoredVerdicts): VerdictDelta {
  const byKey = new Map<string, AssertionResult>()
  before.results.forEach((r, i) => byKey.set(r.id ?? `#${i}`, r))
  const changed: VerdictDelta['changed_assertions'] = []
  after.results.forEach((r, i) => {
    const key = r.id ?? `#${i}`
    const prior = byKey.get(key)
    if (prior && prior.verdict !== r.verdict) {
      changed.push({ id: key, before: prior.verdict, after: r.verdict })
    }
  })
  return { before: before.verdict, after: after.verdict, changed_assertions: changed }
}

export const captureProofTool: ToolDef = {
  name: 'capture_proof',
  description:
    'Capture one phase of a named before/after proof bundle: an annotated screenshot (returned as a file ' +
    'path, never base64) plus optional stored suite verdicts. Call with phase "before" pre-fix and phase ' +
    '"after" post-fix using the same bundle_id — the after call reports a verdict_delta (suite verdict change ' +
    'and the exact assertions that flipped) as durable evidence the fix worked.',
  inputSchema,
  async handler(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const a = argsSchema.parse(args)

    // Validate the bundle id (and create its directory) before touching the page.
    bundleDir(a.bundle_id)

    // Resolve marks: uid entries pass through, selectors expand to all matches; dedupe, cap.
    // A mark target that legitimately disappeared (e.g. the fix removed the error
    // badge) must NOT abort the capture — the screenshot and verdicts ARE the
    // evidence. Unresolvable targets degrade to a warning; session/CDP errors
    // still propagate.
    const warnings: string[] = []
    const uids: string[] = []
    const seen = new Set<string>()
    outer: for (const target of a.targets) {
      let nodes
      try {
        nodes = await resolveAssertTarget(ctx, target)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (err instanceof TargetResolutionError || /Unknown uid|no longer resolves/i.test(msg)) {
          const label = typeof target === 'string' ? target : target.selector
          warnings.push(`target '${label}' did not resolve — not marked (${sanitizePageText(msg, 200)})`)
          continue
        }
        throw err
      }
      for (const node of nodes) {
        if (seen.has(node.uid)) continue
        seen.add(node.uid)
        uids.push(node.uid)
        if (uids.length >= MAX_TARGETS) break outer
      }
    }

    const shot = await annotatedScreenshotTool.handler(ctx, uids.length > 0 ? { uids } : {})
    const image = shot.images?.[0]
    if (!image) {
      throw new Error('screenshot capture returned no image — retry, or reconnect if the page was closed')
    }
    const png = Buffer.from(image.data, 'base64')

    let phaseVerdicts: StoredVerdicts | undefined
    if (a.suite_id !== undefined) {
      const { results, verdict } = await runSuiteOrAssertions(ctx, { suite_id: a.suite_id })
      phaseVerdicts = { verdict, results }
    }

    const saved = savePhase(a.bundle_id, a.phase, png, phaseVerdicts)
    if (!saved.imagePath) {
      throw new Error(`bundle image write failed for '${a.bundle_id}' — check $VISIONAIRE_ARTIFACTS_DIR is writable`)
    }

    let delta: VerdictDelta | undefined
    if (a.phase === 'after') {
      const beforeVerdicts = asStoredVerdicts(loadPhaseVerdicts(a.bundle_id, 'before'))
      if (!hasPhase(a.bundle_id, 'before')) {
        warnings.push('BUNDLE_PHASE_MISSING: no before phase captured — delta unavailable')
      } else if (beforeVerdicts && phaseVerdicts) {
        delta = buildDelta(beforeVerdicts, phaseVerdicts)
      } else if (!beforeVerdicts) {
        warnings.push('before phase has no stored verdicts (captured without suite_id) — delta unavailable')
      } else {
        warnings.push('pass suite_id to compare against the stored before verdicts — delta unavailable')
      }
    }

    let summary = `Bundle '${a.bundle_id}' ${a.phase.toUpperCase()} captured`
    if (delta) {
      summary += `; suite now ${delta.after} (was ${delta.before})`
    } else if (phaseVerdicts) {
      summary += `; suite ${phaseVerdicts.verdict}`
    }
    if (a.note !== undefined && a.note.length > 0) {
      summary += ` — ${sanitizePageText(a.note, 120)}`
    }

    const envelope: Envelope = {
      summary,
      bundle_id: a.bundle_id,
      phase: a.phase,
      artifacts: [{ kind: 'annotated_screenshot', path: saved.imagePath }],
      truncated: false,
    }
    if (delta) envelope.verdict_delta = delta
    if (warnings.length > 0) envelope.warnings = warnings

    return { text: JSON.stringify(envelope, null, 1) }
  },
}
