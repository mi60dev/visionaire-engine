/**
 * Seeded-bug benchmark runner — SPEC §12 item 4 (CLI, not the MCP server:
 * console.log is fine here, like scripts/demo.ts).
 *
 *   npx tsx bench/run.ts        # all 23 cases
 *   npx tsx bench/run.ts 11     # one case by manifest id
 *
 * Drives the real ToolDef handlers against bench/cases/*.html and scores
 * whether the engine's output names the true cause (every `expected` substring
 * must appear), plus the context token cost: the tool output and one
 * page_snapshot per case, reported separately. Exit code 1 on any FAIL — or
 * any XPASS, which means an expected_fail started passing and the manifest
 * must be tightened.
 *
 * Cases with `"serve": "http"` are served from a local node:http server
 * instead of file:// — the v0.3 time-dimension cases need a real origin
 * (LoAF script attribution is empty on file:// pages, SPEC §14).
 */
import fs from 'node:fs'
import http from 'node:http'
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

const TOOLS: Record<string, ToolDef> = {
  explain_styles: explainStylesTool,
  inspect_element: inspectElementTool,
  inspect_ancestors: inspectAncestorsTool,
}

/**
 * The v0.3 time-dimension tools are imported lazily (per case, cached) so the
 * legacy cases keep running even when a tool module is absent or broken — a
 * missing module fails only the cases that need it, with an actionable error.
 */
const LAZY_TOOLS: Record<string, { specifier: string; exportName: string }> = {
  get_listeners: { specifier: '../src/tools/get-listeners.js', exportName: 'getListenersTool' },
  explain_animations: {
    specifier: '../src/tools/explain-animations.js',
    exportName: 'explainAnimationsTool',
  },
  record_interaction: {
    specifier: '../src/tools/record-interaction.js',
    exportName: 'recordInteractionTool',
  },
}

const lazyToolCache = new Map<string, ToolDef>()

async function resolveTool(name: string): Promise<ToolDef> {
  const eager = TOOLS[name]
  if (eager) return eager
  const cached = lazyToolCache.get(name)
  if (cached) return cached
  const lazy = LAZY_TOOLS[name]
  if (!lazy) throw new Error(`unknown tool "${name}"`)
  let mod: Record<string, unknown>
  try {
    mod = (await import(new URL(lazy.specifier, import.meta.url).href)) as Record<string, unknown>
  } catch (err) {
    throw new Error(
      `tool "${name}" is unavailable — loading ${lazy.specifier} failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const def = mod[lazy.exportName] as ToolDef | undefined
  if (!def) throw new Error(`tool "${name}": ${lazy.specifier} does not export ${lazy.exportName}`)
  lazyToolCache.set(name, def)
  return def
}

interface BenchCase {
  id: number
  file: string
  user_report: string
  target: { uid?: string; selector?: string; x?: number; y?: number }
  tool: string
  args?: Record<string, unknown>
  serve?: 'http'
  expected: string[]
  expected_fail?: boolean
  reason?: string
  notes?: string
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

/** Static server over the bench/ directory for `serve: "http"` cases. */
async function startFixtureServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://bench').pathname)
    const filePath = path.join(here, path.normalize(urlPath))
    if (filePath !== here && !filePath.startsWith(here + path.sep)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    try {
      const body = fs.readFileSync(filePath)
      res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end('not found')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server: no port')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
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
    if (!TOOLS[c.tool] && !LAZY_TOOLS[c.tool]) throw new Error(`case ${c.id}: unknown tool "${c.tool}"`)
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

async function runCase(session: SessionManager, c: BenchCase, baseUrl?: string): Promise<CaseResult> {
  const tool = await resolveTool(c.tool) // before navigating: a missing tool fails fast
  const url =
    c.serve === 'http' && baseUrl !== undefined
      ? `${baseUrl}/${c.file}`
      : pathToFileURL(path.resolve(here, c.file)).href
  await session.navigate(url)
  const ctx = session.context()

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
  const fixtureServer = cases.some((c) => c.serve === 'http') ? await startFixtureServer() : undefined
  try {
    await session.connect({ mode: 'launch', headless: true })
    for (const c of cases) {
      try {
        results.push(await runCase(session, c, fixtureServer?.baseUrl))
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
    await fixtureServer?.close()
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
