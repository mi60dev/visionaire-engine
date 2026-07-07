/**
 * diagnose e2e — real Chrome over test/fixtures/diagnose.html.
 * Auto-skips when no Chrome is installed. Drives the ToolDef handler directly.
 * Fixture geometry is documented in the fixture's header comment; the exact
 * expected numbers asserted here (±1px) are: 34px right clip exceed (a),
 * 40/10px centering gaps (c), 100x40px overlap rect (e), 320px measured width
 * vs 200px expected (f). Text overflow (b) is font-dependent, so it is
 * cross-checked against in-page scroll metrics instead of a constant.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findChromeExecutable, SessionManager } from '../src/session.js'
import { diagnoseTool } from '../src/tools/diagnose.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureUrl = (name: string): string => pathToFileURL(path.resolve(here, 'fixtures', name)).href

const chromePath = findChromeExecutable()

interface Culprit {
  rank: number
  confidence: 'high' | 'medium' | 'low'
  cause: string
  plain: string
  evidence: Record<string, unknown>
}

interface Envelope {
  summary: string
  symptom_detected: string
  culprits: Culprit[]
  truncated: boolean
}

describe.skipIf(!chromePath)('diagnose e2e — real Chrome', () => {
  const session = new SessionManager()

  beforeAll(async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'visionaire-diagnose-test-'))
    process.env['VISIONAIRE_ARTIFACTS_DIR'] = path.join(scratch, 'artifacts')
    process.env['VISIONAIRE_SUITE_DIR'] = path.join(scratch, 'suites')
    await session.connect({ mode: 'launch', headless: true })
    await session.navigate(fixtureUrl('diagnose.html'))
  })

  afterAll(async () => {
    await session.disconnect()
  })

  async function run(args: Record<string, unknown>): Promise<Envelope> {
    const res = await diagnoseTool.handler(session.context(), args)
    const env = JSON.parse(res.text) as Envelope
    expect(env).toHaveProperty('summary')
    expect(env).toHaveProperty('symptom_detected')
    expect(env).toHaveProperty('culprits')
    expect(env).toHaveProperty('truncated')
    return env
  }

  it('clipped: names the overflow:hidden ancestor and the exact 34px right exceed', async () => {
    const env = await run({ selector: '#clipped', symptom: 'clipped' })
    expect(env.symptom_detected).toBe('clipped')
    const top = env.culprits[0]!
    expect(top.rank).toBe(1)
    expect(top.cause).toBe('ancestor_overflow_clip')
    expect(top.confidence).toBe('high')
    expect(top.evidence['exceed_right']).toBeCloseTo(34, 0)
    expect(Math.abs((top.evidence['exceed_right'] as number) - 34)).toBeLessThanOrEqual(1)
    expect(top.evidence['overflow']).toBe('hidden')
    expect(String(top.evidence['ancestor_identity'])).toContain('clip-wrap')
    expect(top.plain).toMatch(/right/)
  })

  it('overflowing: rank-1 text_overflow whose exceed matches in-page scroll metrics', async () => {
    const env = await run({
      selector: '#overflow-text',
      symptom: 'overflowing',
    })
    expect(env.symptom_detected).toBe('overflowing')
    const top = env.culprits[0]!
    expect(top.rank).toBe(1)
    expect(top.cause).toBe('text_overflow')
    expect(top.confidence).toBe('high')
    const exceed = top.evidence['exceed_right'] as number
    expect(exceed).toBeGreaterThan(10)
    // Cross-check against the live scroll overflow (integer px) — same fact,
    // measured independently in-page.
    const scrollOverflow = await session.context().page.evaluate(() => {
      const el = document.querySelector('#overflow-text') as HTMLElement
      return el.scrollWidth - el.clientWidth
    })
    expect(Math.abs(exceed - scrollOverflow)).toBeLessThanOrEqual(2)
  })

  it('not_centered: reports the exact 40px vs 10px gap asymmetry on the x axis', async () => {
    const env = await run({ selector: '#off-center', symptom: 'not_centered' })
    expect(env.symptom_detected).toBe('not_centered')
    const top = env.culprits[0]!
    expect(top.rank).toBe(1)
    expect(top.cause).toBe('off_center')
    expect(top.evidence['axis']).toBe('x')
    expect(Math.abs((top.evidence['gap_left'] as number) - 40)).toBeLessThanOrEqual(1)
    expect(Math.abs((top.evidence['gap_right'] as number) - 10)).toBeLessThanOrEqual(1)
    expect(Math.abs((top.evidence['off_by_px'] as number) - 15)).toBeLessThanOrEqual(1)
    expect(top.confidence).toBe('high') // 30px asymmetry
  })

  it('invisible: maps display:none to invisible_display-none with high confidence', async () => {
    const env = await run({ selector: '#invisible', symptom: 'invisible' })
    expect(env.symptom_detected).toBe('invisible')
    const top = env.culprits[0]!
    expect(top.rank).toBe(1)
    expect(top.cause).toBe('invisible_display-none')
    expect(top.confidence).toBe('high')
    expect(top.evidence['status']).toBe('display-none')
  })

  it('overlapping: names the overlay on top with the exact 100x40 overlap rect', async () => {
    const env = await run({ selector: '#covered', symptom: 'overlapping' })
    expect(env.symptom_detected).toBe('overlapping')
    const top = env.culprits[0]!
    expect(top.rank).toBe(1)
    expect(top.cause).toBe('overlapped_by_sibling')
    expect(String(top.evidence['above_identity'])).toContain('overlay')
    expect(Math.abs((top.evidence['overlap_width'] as number) - 100)).toBeLessThanOrEqual(1)
    expect(Math.abs((top.evidence['overlap_height'] as number) - 40)).toBeLessThanOrEqual(1)
    expect(top.confidence).toBe('high')
  })

  it('wrong_size: measures 320px vs expected 200px and names the winning declaration', async () => {
    const env = await run({
      selector: '#sized',
      symptom: 'wrong_size',
      expected: { width_px: 200 },
    })
    expect(env.symptom_detected).toBe('wrong_size')
    const top = env.culprits[0]!
    expect(top.rank).toBe(1)
    expect(top.cause).toBe('size_driven_by_declaration')
    expect(Math.abs((top.evidence['measured_px'] as number) - 320)).toBeLessThanOrEqual(1)
    expect(top.evidence['expected_px']).toBe(200)
    expect(Math.abs((top.evidence['delta_px'] as number) - 120)).toBeLessThanOrEqual(1)
    expect(top.evidence['constraining_property']).toBe('width')
    expect(top.evidence['selector']).toBe('#sized')
    expect(top.evidence['value']).toBe('320px')
    expect(top.evidence['important']).toBe(false)
    expect(top.confidence).toBe('high')
  })

  it('auto mode detects clipped on #clipped and ranks the clip culprit first', async () => {
    const env = await run({ selector: '#clipped' }) // symptom defaults to 'auto'
    expect(env.symptom_detected).toBe('clipped')
    const top = env.culprits[0]!
    expect(top.rank).toBe(1)
    expect(top.cause).toBe('ancestor_overflow_clip')
    expect(Math.abs((top.evidence['exceed_right'] as number) - 34)).toBeLessThanOrEqual(1)
  })

  it('reports NO_SYMPTOM for a healthy centered element', async () => {
    const env = await run({ selector: '#healthy' })
    expect(env.symptom_detected).toBe('none')
    expect(env.culprits).toEqual([])
    expect(env.truncated).toBe(false)
    expect(env.summary).toMatch(/renders as expected within tolerances/)
    expect(env.summary).toMatch(/checks run/)
  })

  it('is deterministic: two identical calls return deep-equal JSON', async () => {
    const first = await run({ selector: '#clipped', symptom: 'auto' })
    const second = await run({ selector: '#clipped', symptom: 'auto' })
    expect(second).toEqual(first)
  })

  it('wrong_size without expected dimensions throws an actionable error', async () => {
    await expect(run({ selector: '#sized', symptom: 'wrong_size' })).rejects.toThrow(/expected\.width_px/)
  })
})
