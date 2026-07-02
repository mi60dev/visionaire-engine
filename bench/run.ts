/**
 * Seeded-bug benchmark runner — SPEC §12 item 4 (CLI, not the MCP server:
 * console.log is fine here, like scripts/demo.ts).
 *
 *   npx tsx bench/run.ts        # all 20 cases
 *   npx tsx bench/run.ts 11     # one case by manifest id
 *
 * Drives the real ToolDef handlers against bench/cases/*.html and scores
 * whether the engine's output names the true cause (every `expected` substring
 * must appear), plus the context token cost: the tool output and one
 * page_snapshot per case, reported separately. Exit code 1 on any FAIL — or
 * any XPASS, which means an expected_fail started passing and the manifest
 * must be tightened.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findChromeExecutable, SessionManager } from '../src/session.js'
import { explainStylesTool } from '../src/tools/explain-styles.js'
import { inspectAncestorsTool } from '../src/tools/inspect-ancestors.js'
import { inspectElementTool } from '../src/tools/inspect-element.js'
import { pageSnapshotTool } from '../src/tools/page-snapshot.js'
import type { ToolDef } from '../src/types.js'
import { estimateTokens } from '../src/types.js'

const here = path.dirname(fileURLToPath(import.meta.url))

type BenchTool = 'explain_styles' | 'inspect_element' | 'inspect_ancestors'

const TOOLS: Record<BenchTool, ToolDef> = {
  explain_styles: explainStylesTool,
  inspect_element: inspectElementTool,
  inspect_ancestors: inspectAncestorsTool,
}

interface BenchCase {
  id: number
  file: string
  user_report: string
  target: { uid?: string; selector?: string; x?: number; y?: number }
  tool: BenchTool
  args?: Record<string, unknown>
  expected: string[]
  expected_fail?: boolean
  reason?: string
  notes?: string
}

type Status = 'PASS' | 'FAIL' | 'XFAIL' | 'XPASS'

interface CaseResult {
  c: BenchCase
  status: Status
  missing: string[]
  toolTokens: number
  snapshotTokens: number
  output: string
}

function loadManifest(): BenchCase[] {
  const raw = fs.readFileSync(path.join(here, 'manifest.json'), 'utf8')
  const cases = JSON.parse(raw) as BenchCase[]
  for (const c of cases) {
    if (!TOOLS[c.tool]) throw new Error(`case ${c.id}: unknown tool "${c.tool}"`)
    if (!Array.isArray(c.expected) || c.expected.length === 0) {
      throw new Error(`case ${c.id}: empty expected markers`)
    }
  }
  return cases
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
}

async function runCase(session: SessionManager, c: BenchCase): Promise<CaseResult> {
  await session.navigate(pathToFileURL(path.resolve(here, c.file)).href)
  const ctx = session.context()

  const tool = TOOLS[c.tool]
  const res = await tool.handler(ctx, { ...c.target, ...(c.args ?? {}) })
  const missing = c.expected.filter((marker) => !res.text.includes(marker))

  // The context an agent would realistically spend per case: one census to find
  // the element, plus the diagnostic tool output. Reported separately.
  const snapshot = await pageSnapshotTool.handler(ctx, {})

  const hit = missing.length === 0
  const status: Status = c.expected_fail ? (hit ? 'XPASS' : 'XFAIL') : hit ? 'PASS' : 'FAIL'
  return {
    c,
    status,
    missing,
    toolTokens: estimateTokens(res.text),
    snapshotTokens: estimateTokens(snapshot.text),
    output: res.text,
  }
}

async function main(): Promise<void> {
  const filterArg = process.argv[2]
  let cases = loadManifest()
  if (filterArg !== undefined) {
    const id = Number(filterArg)
    cases = cases.filter((c) => c.id === id)
    if (cases.length === 0) {
      console.error(`No case with id ${filterArg} in bench/manifest.json.`)
      process.exit(2)
    }
  }

  if (!findChromeExecutable()) {
    console.error('No Chrome executable found (set CHROME_PATH) — the benchmark needs a real browser.')
    process.exit(1)
  }

  const started = Date.now()
  const session = new SessionManager()
  const results: CaseResult[] = []
  try {
    await session.connect({ mode: 'launch', headless: true })
    for (const c of cases) {
      try {
        results.push(await runCase(session, c))
      } catch (err) {
        results.push({
          c,
          status: c.expected_fail ? 'XFAIL' : 'FAIL',
          missing: [...c.expected],
          toolTokens: 0,
          snapshotTokens: 0,
          output: `tool threw: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    }
  } finally {
    await session.disconnect()
  }

  // ── per-case table ──
  console.log('id  status  tool-tok  snap-tok  tool               user report')
  for (const r of results) {
    const row = [
      String(r.c.id).padStart(2),
      r.status.padEnd(6),
      String(r.toolTokens).padStart(8),
      String(r.snapshotTokens).padStart(8),
      r.c.tool.padEnd(17),
      r.c.user_report.length > 60 ? `${r.c.user_report.slice(0, 59)}…` : r.c.user_report,
    ]
    console.log(row.join('  '))
    if (r.status === 'FAIL') {
      console.log(`      missing markers: ${r.missing.map((m) => JSON.stringify(m)).join(', ')}`)
      console.log(`      --- tool output ---`)
      for (const line of r.output.split('\n')) console.log(`      ${line}`)
      console.log(`      -------------------`)
    }
    if (r.status === 'XFAIL') {
      console.log(`      xfail: ${r.c.reason ?? 'no reason recorded'}`)
    }
    if (r.status === 'XPASS') {
      console.log('      XPASS: tighten the manifest — this expected_fail now passes; drop expected_fail and firm up the markers.')
    }
  }

  // ── summary ──
  const passes = results.filter((r) => r.status === 'PASS').length
  const fails = results.filter((r) => r.status === 'FAIL').length
  const xfails = results.filter((r) => r.status === 'XFAIL').length
  const xpasses = results.filter((r) => r.status === 'XPASS').length
  const totals = results.map((r) => r.toolTokens + r.snapshotTokens)
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)

  const extras: string[] = []
  if (xfails > 0) extras.push(`${xfails} xfail`)
  if (xpasses > 0) extras.push(`${xpasses} XPASS`)
  console.log('')
  console.log(
    `${passes}/${results.length} pass${extras.length ? ` (${extras.join(', ')})` : ''}, median context tokens ${median(totals)}` +
      ` (median tool ${median(results.map((r) => r.toolTokens))} + snapshot ${median(results.map((r) => r.snapshotTokens))}; ${elapsed}s)`,
  )

  process.exitCode = fails > 0 || xpasses > 0 ? 1 : 0
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exitCode = 1
})
