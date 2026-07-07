/**
 * responsive_sweep e2e — real Chrome, headless, file:// fixture.
 *
 * fixtures/sweep.html geometry: the two .card elements are equal height above
 * 800px viewport width (flex row + stretch) but a max-width:800px media query
 * stacks them and pads .card--b, so equal_height FAILs at 375x812 and PASSes
 * at 1280x800. #wide (500px fixed) is clipped by #clip (overflow:hidden) only
 * at narrow viewports — the diagnose probe target.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findChromeExecutable, SessionManager } from '../src/session.js'
import { responsiveSweepTool } from '../src/tools/responsive-sweep.js'
import { assertVisualTool } from '../src/tools/assert-visual.js'
import type { ToolResult } from '../src/types.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureUrl = (name: string): string => pathToFileURL(path.resolve(here, 'fixtures', name)).href

const chromePath = findChromeExecutable()

// The diagnose payload depends on src/engine/diagnose.ts (built in parallel to a
// fixed cross-module contract); skip only the diagnose test while it is absent.
const diagnoseReady = fs.existsSync(path.resolve(here, '../src/engine/diagnose.ts'))

interface SweepCell {
  viewport: string
  verdict?: string
  failed?: Array<{ id?: string; type: string; measured?: Record<string, unknown>; offending_uids?: string[] }>
  error?: string
  symptom_detected?: string
  top_culprit?: { cause: string; plain: string }
}

interface SweepEnvelope {
  summary: string
  matrix: SweepCell[]
  truncated: boolean
}

describe.skipIf(!chromePath)('responsive_sweep e2e — real Chrome', () => {
  const session = new SessionManager()
  let markerDir = ''

  beforeAll(async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'visionaire-sweep-'))
    markerDir = path.join(scratch, 'marker')
    process.env['VISIONAIRE_ARTIFACTS_DIR'] = path.join(scratch, 'artifacts')
    process.env['VISIONAIRE_SUITE_DIR'] = path.join(scratch, 'suites')
    process.env['VISIONAIRE_MARKER_DIR'] = markerDir
    await session.connect({ mode: 'launch', headless: true })
    await session.navigate(fixtureUrl('sweep.html'))
    // Register the suite the sweep re-runs per viewport.
    await assertVisualTool.handler(session.context(), {
      assertions: [{ type: 'equal_height', targets: [{ selector: '.card' }] }],
      suite_id: 'sweep-test',
    })
  })

  afterAll(async () => {
    await session.disconnect()
  })

  const run = (args: Record<string, unknown>): Promise<ToolResult> =>
    responsiveSweepTool.handler(session.context(), args)
  const parse = (res: ToolResult): SweepEnvelope => JSON.parse(res.text) as SweepEnvelope

  it('suite run: FAIL at 375x812 with measured values, PASS at 1280x800, viewport restored', async () => {
    const original = session.context().page.viewport()
    expect(original).not.toBeNull()

    const res = await run({
      run: { suite_id: 'sweep-test' },
      viewports: [
        { width: 375, height: 812 },
        { width: 1280, height: 800 },
      ],
    })
    const env = parse(res)
    expect(env.matrix).toHaveLength(2)
    expect(env.truncated).toBe(false)

    const narrow = env.matrix.find((c) => c.viewport === '375x812')
    const wide = env.matrix.find((c) => c.viewport === '1280x800')
    expect(narrow).toBeDefined()
    expect(wide).toBeDefined()

    // Narrow: the media query breaks the card heights apart — FAIL with numbers.
    expect(narrow!.verdict).toBe('FAIL')
    expect(narrow!.failed).toBeDefined()
    expect(narrow!.failed![0]!.type).toBe('equal_height')
    expect(narrow!.failed![0]!.measured).toBeDefined()
    // No prose explanations in matrix cells.
    expect(JSON.stringify(narrow)).not.toContain('explanation')

    // Wide: PASS cells collapse to the verdict alone.
    expect(wide!.verdict).toBe('PASS')
    expect(wide!.failed).toBeUndefined()

    expect(env.summary).toContain("Suite 'sweep-test'")
    expect(env.summary).toContain('FAIL at 375x812 (equal_height)')
    expect(env.summary).toContain('PASS at 1280x800')

    // The original viewport is restored after the sweep.
    const after = session.context().page.viewport()
    expect(after?.width).toBe(original!.width)
    expect(after?.height).toBe(original!.height)

    // A sweep counts as a verification pass for the Stop-hook gate.
    const marker = path.join(markerDir, '.visionaire_verified')
    expect(fs.existsSync(marker)).toBe(true)
    expect(fs.readFileSync(marker, 'utf8')).toContain('responsive_sweep')
  })

  it('inline assertions run works (no stored suite needed), including string color values', async () => {
    const res = await run({
      run: {
        assertions: [
          { id: 'cards', type: 'equal_height', targets: [{ selector: '.card' }] },
          // A CSS color STRING value — the sweep schema once rejected these
          // (schema drift vs assert_visual); shared schema keeps them accepted.
          {
            id: 'card-bg',
            type: 'color_equals',
            targets: [{ selector: '.card--a' }],
            params: { property: 'background', value: '#e3f2fd' },
          },
        ],
      },
      viewports: [
        { width: 375, height: 812 },
        { width: 1280, height: 800 },
      ],
    })
    const env = parse(res)
    const narrow = env.matrix.find((c) => c.viewport === '375x812')
    const wide = env.matrix.find((c) => c.viewport === '1280x800')
    expect(narrow!.verdict).toBe('FAIL')
    // Only equal_height breaks at narrow — the color assertion passes everywhere.
    expect(narrow!.failed).toHaveLength(1)
    expect(narrow!.failed![0]!.id).toBe('cards')
    expect(wide!.verdict).toBe('PASS')
    expect(env.summary).toContain('Assertions:')
  })

  it.skipIf(!diagnoseReady)('diagnose run: clipped element detected at narrow width only', async () => {
    const res = await run({
      run: { diagnose: { target: { selector: '#wide' }, symptom: 'clipped' } },
      viewports: [
        { width: 375, height: 812 },
        { width: 1280, height: 800 },
      ],
    })
    const env = parse(res)
    expect(env.matrix).toHaveLength(2)
    const narrow = env.matrix.find((c) => c.viewport === '375x812')
    const wide = env.matrix.find((c) => c.viewport === '1280x800')
    expect(narrow).toBeDefined()
    expect(wide).toBeDefined()
    // Diagnose cells carry symptom_detected (+ top culprit), not a PASS/FAIL verdict.
    expect(narrow!.verdict).toBeUndefined()
    // Narrow: #wide (500px) overflows #clip (~335px, overflow:hidden) — the probe
    // must name the symptom AND blame the clipping ancestor, not just say something.
    expect(narrow!.symptom_detected).toBe('clipped')
    expect(narrow!.top_culprit).toBeDefined()
    expect(narrow!.top_culprit!.cause).toBe('ancestor_overflow_clip')
    // Wide: #clip is ~1240px, #wide fits — nothing to report, no culprit invented.
    expect(wide!.symptom_detected).toBe('none')
    expect(wide!.top_culprit).toBeUndefined()
    expect(env.summary).toContain('Diagnose:')
  })

  it('deviceScaleFactor 2 yields the same verdict as dsf 1 (CSS-px measurements are dpr-invariant)', async () => {
    const res = await run({
      run: { suite_id: 'sweep-test' },
      viewports: [
        { width: 1280, height: 800 },
        { width: 1280, height: 800, deviceScaleFactor: 2 },
      ],
    })
    const env = parse(res)
    expect(env.matrix).toHaveLength(2)
    // Both cells share the 1280x800 label — assert by position (input order is preserved).
    expect(env.matrix[0]!.verdict).toBe('PASS')
    expect(env.matrix[1]!.verdict).toBe('PASS')
  })

  it('a per-viewport error becomes an ERROR cell without aborting the sweep', async () => {
    // .nope matches nothing → the engine reports per-assertion ERROR results, and
    // the sweep still returns one cell per viewport (FAIL cells with error rows).
    const res = await run({
      run: { assertions: [{ type: 'equal_height', targets: [{ selector: '.nope' }] }] },
      viewports: [
        { width: 375, height: 812 },
        { width: 1280, height: 800 },
      ],
    })
    const env = parse(res)
    expect(env.matrix).toHaveLength(2)
    for (const cell of env.matrix) {
      expect(cell.verdict).toBe('FAIL')
      expect(cell.failed![0]!.type).toBe('equal_height')
    }
  })

  it('rejects more than 8 viewports with guidance', async () => {
    const nine = Array.from({ length: 9 }, () => ({ width: 400, height: 400 }))
    await expect(run({ run: { suite_id: 'sweep-test' }, viewports: nine })).rejects.toThrow(/max 8/)
  })

  it('unknown suite throws SUITE_NOT_FOUND before any viewport churn', async () => {
    const before = session.context().page.viewport()
    await expect(
      run({ run: { suite_id: 'no-such-suite' }, viewports: [{ width: 375, height: 812 }] }),
    ).rejects.toThrow(/SUITE_NOT_FOUND/)
    // Failing fast means the viewport was never touched.
    expect(session.context().page.viewport()?.width).toBe(before?.width)
  })

  it('run must carry exactly one payload', async () => {
    await expect(run({ run: {} })).rejects.toThrow(/exactly one/)
    await expect(
      run({
        run: {
          suite_id: 'sweep-test',
          assertions: [{ type: 'equal_height', targets: [{ selector: '.card' }] }],
        },
      }),
    ).rejects.toThrow(/exactly one/)
  })
})
