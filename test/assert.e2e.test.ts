/**
 * assert_visual e2e — real headless Chrome over test/fixtures/assert.html.
 * The fixture's geometry contract is documented in its header comment; the
 * numbers asserted here (412 vs 388, gaps 16/16/16, exceed 34px, …) are
 * load-bearing in both files. Auto-skips without Chrome.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SessionManager, findChromeExecutable } from '../src/session.js'
import { assertVisualTool } from '../src/tools/assert-visual.js'
import type { AssertionResult } from '../src/engine/assert.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureUrl = (name: string): string => pathToFileURL(path.resolve(here, 'fixtures', name)).href
const chromePath = findChromeExecutable()

interface Envelope {
  verdict: 'PASS' | 'FAIL'
  summary: string
  results: AssertionResult[]
  suite_id?: string
  truncated: boolean
  next_offset?: number
}

describe.skipIf(!chromePath)('assert_visual e2e — real Chrome', () => {
  const session = new SessionManager()
  let scratch: string

  const run = async (args: Record<string, unknown>): Promise<Envelope> => {
    const res = await assertVisualTool.handler(session.context(), args)
    return JSON.parse(res.text) as Envelope
  }
  const byId = (env: Envelope, id: string): AssertionResult => {
    const r = env.results.find((x) => x.id === id)
    expect(r, `result '${id}' present in: ${env.summary}`).toBeDefined()
    return r!
  }

  beforeAll(async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'visionaire-assert-'))
    process.env['VISIONAIRE_SUITE_DIR'] = path.join(scratch, 'suites')
    process.env['VISIONAIRE_MARKER_DIR'] = path.join(scratch, 'marker')
    await session.connect({ mode: 'launch', headless: true })
    await session.navigate(fixtureUrl('assert.html'))
  })

  afterAll(async () => {
    delete process.env['VISIONAIRE_SUITE_DIR']
    delete process.env['VISIONAIRE_MARKER_DIR']
    await session.disconnect()
    fs.rmSync(scratch, { recursive: true, force: true })
  })

  it('runs the full grammar battery with exact measured pixels', async () => {
    const env = await run({
      detail: 'full',
      assertions: [
        { id: 'eq-h', type: 'equal_height', targets: [{ selector: '.card' }] },
        { id: 'eq-w', type: 'equal_width', targets: [{ selector: '.card' }] },
        { id: 'align-top', type: 'aligned_edges', targets: [{ selector: '.card' }], params: { edge: 'top' } },
        { id: 'ctr-ok', type: 'centered', targets: [{ selector: '#centered' }], params: { in: 'parent', axis: 'x' } },
        { id: 'ctr-off', type: 'centered', targets: [{ selector: '#off-center' }], params: { in: 'parent', axis: 'x' } },
        { id: 'gap', type: 'gap_equals', targets: [{ selector: '.nav-item' }], params: { axis: 'x', value: 16 } },
        { id: 'spacing', type: 'spacing_equals', targets: [{ selector: '.bad-item' }], params: { axis: 'x' } },
        { id: 'clip', type: 'not_clipped', targets: [{ selector: '#clipped' }] },
        { id: 'overlap', type: 'not_overlapped', targets: [{ selector: '#base' }] },
        { id: 'z', type: 'z_above', targets: [{ selector: '#badge' }, { selector: '#base' }] },
        { id: 'vis-ok', type: 'visible', targets: [{ selector: '#sized' }] },
        { id: 'vis-no', type: 'visible', targets: [{ selector: '#hidden' }] },
        { id: 'vp', type: 'within_viewport', targets: [{ selector: '#offscreen' }] },
        { id: 'size', type: 'size_equals', targets: [{ selector: '#sized' }], params: { width_px: 320, height_px: 50 } },
        { id: 'trunc', type: 'text_not_truncated', targets: [{ selector: '#trunc' }] },
        { id: 'pos', type: 'positioned', targets: [{ selector: '#card-a' }, { selector: '#card-b' }], params: { relation: 'left_of' } },
        { id: 'col-txt', type: 'color_equals', targets: [{ selector: '#swatch' }], params: { property: 'text', value: '#008000' } },
        { id: 'col-bg', type: 'color_near', targets: [{ selector: '#swatch' }], params: { property: 'background', value: '#ff0000' } },
      ],
    })

    expect(env.verdict).toBe('FAIL') // the fixture is deliberately half-broken

    // The anti-gaslighting core: FAIL carries the measured numbers.
    const eq = byId(env, 'eq-h')
    expect(eq.verdict).toBe('FAIL')
    expect(eq.measured).toMatchObject({ values: [412, 388], delta: 24 })
    expect(eq.offending_uids?.length).toBe(2)

    expect(byId(env, 'eq-w').verdict).toBe('PASS')
    expect(byId(env, 'align-top').verdict).toBe('PASS')

    const ctrOk = byId(env, 'ctr-ok')
    expect(ctrOk.verdict).toBe('PASS')
    expect(ctrOk.measured).toMatchObject({ left_gap: 100, right_gap: 100 })

    const ctrOff = byId(env, 'ctr-off')
    expect(ctrOff.verdict).toBe('FAIL')
    expect(ctrOff.measured).toMatchObject({ left_gap: 40, right_gap: 10, delta_x: 30 })

    const gap = byId(env, 'gap')
    expect(gap.verdict).toBe('PASS')
    expect(gap.measured).toMatchObject({ gaps: [16, 16, 16], expected: 16 })

    const spacing = byId(env, 'spacing')
    expect(spacing.verdict).toBe('FAIL')
    expect(spacing.measured).toMatchObject({ gaps: [16, 8, 16] })

    const clip = byId(env, 'clip')
    expect(clip.verdict).toBe('FAIL')
    expect((clip.measured as { exceed: { right: number } }).exceed.right).toBe(34)
    expect(clip.explanation).toContain('overflow:hidden')

    const overlap = byId(env, 'overlap')
    expect(overlap.verdict).toBe('FAIL')
    expect((overlap.measured as { overlap_rect: { width: number; height: number } }).overlap_rect).toMatchObject({
      width: 20,
      height: 20,
    })

    expect(byId(env, 'z').verdict).toBe('PASS')
    expect(byId(env, 'vis-ok').verdict).toBe('PASS')
    const visNo = byId(env, 'vis-no')
    expect(visNo.verdict).toBe('FAIL')
    expect(visNo.explanation).toContain('display:none')

    expect(byId(env, 'vp').verdict).toBe('FAIL')
    expect(byId(env, 'size').verdict).toBe('PASS')

    const trunc = byId(env, 'trunc')
    expect(trunc.verdict).toBe('FAIL')
    expect((trunc.measured as { clientWidth: number }).clientWidth).toBe(120)

    expect(byId(env, 'pos').verdict).toBe('PASS')
    expect(byId(env, 'col-txt').verdict).toBe('PASS')

    const bg = byId(env, 'col-bg')
    expect(bg.verdict).toBe('PASS')
    expect((bg.measured as { method: string }).method).toContain('painted')
  })

  it('is deterministic — identical envelope across runs', async () => {
    const args = {
      assertions: [
        { id: 'eq', type: 'equal_height', targets: [{ selector: '.card' }] },
        { id: 'gap', type: 'gap_equals', targets: [{ selector: '.nav-item' }], params: { axis: 'x', value: 16 } },
      ],
      detail: 'full',
    }
    const a = await assertVisualTool.handler(session.context(), args)
    const b = await assertVisualTool.handler(session.context(), args)
    expect(a.text).toBe(b.text)
  })

  it('registers a suite, re-runs it by id alone, and persists it to disk', async () => {
    const reg = await run({
      suite_id: 'fixture-suite',
      assertions: [
        { id: 'eq', type: 'equal_height', targets: [{ selector: '.card' }] },
        { id: 'w', type: 'equal_width', targets: [{ selector: '.card' }] },
      ],
    })
    expect(reg.suite_id).toBe('fixture-suite')
    expect(reg.summary).toContain("registered as suite 'fixture-suite'")

    const rerun = await run({ suite_id: 'fixture-suite' })
    expect(rerun.verdict).toBe('FAIL')
    expect(rerun.results.map((r) => r.id)).toEqual(['eq', 'w'])

    expect(fs.existsSync(path.join(scratch, 'suites', 'fixture-suite.json'))).toBe(true)
  })

  it('errors helpfully on an unknown suite', async () => {
    await expect(run({ suite_id: 'no-such-suite' })).rejects.toThrow(/SUITE_NOT_FOUND.*fixture-suite/s)
  })

  it('writes the harness verification marker on every run', async () => {
    const marker = path.join(scratch, 'marker', '.visionaire_verified')
    fs.rmSync(marker, { force: true })
    await run({ assertions: [{ type: 'visible', targets: [{ selector: '#sized' }] }] })
    expect(fs.readFileSync(marker, 'utf8')).toContain('assert_visual')
  })

  it('reports resolution problems as per-assertion ERRORs, not tool failures', async () => {
    const env = await run({
      assertions: [
        { id: 'missing', type: 'visible', targets: [{ selector: '.does-not-exist' }] },
        { id: 'ambiguous', type: 'visible', targets: [{ selector: '.card' }] },
        { id: 'unknown', type: 'equal_vibes', targets: [{ selector: '.card' }] },
        { id: 'ok', type: 'visible', targets: [{ selector: '#sized' }] },
      ],
    })
    expect(env.verdict).toBe('FAIL')
    expect(byId(env, 'missing')).toMatchObject({ verdict: 'ERROR', error: 'TARGET_NOT_FOUND' })
    expect(byId(env, 'missing').explanation).toContain('resolved_count: 0')
    expect(byId(env, 'ambiguous')).toMatchObject({ verdict: 'ERROR', error: 'TARGET_AMBIGUOUS' })
    expect(byId(env, 'unknown')).toMatchObject({ verdict: 'ERROR', error: 'UNKNOWN_ASSERTION_TYPE' })
    expect(byId(env, 'ok').verdict).toBe('PASS')
  })

  it('stop_on_first_fail short-circuits and says so', async () => {
    const env = await run({
      stop_on_first_fail: true,
      assertions: [
        { id: 'a', type: 'equal_height', targets: [{ selector: '.card' }] },
        { id: 'b', type: 'visible', targets: [{ selector: '#sized' }] },
        { id: 'c', type: 'visible', targets: [{ selector: '#sized' }] },
      ],
    })
    expect(env.verdict).toBe('FAIL')
    expect(env.results).toHaveLength(1)
    expect(env.summary).toContain('2 not evaluated')
  })

  it('paginates large result sets', async () => {
    const assertions = Array.from({ length: 6 }, (_, i) => ({
      id: `v${i}`,
      type: 'visible',
      targets: [{ selector: '#sized' }],
    }))
    const env = await run({ assertions, page: { offset: 0, limit: 4 } })
    expect(env.results).toHaveLength(4)
    expect(env.truncated).toBe(true)
    expect(env.next_offset).toBe(4)
    const rest = await run({ assertions, page: { offset: 4, limit: 4 } })
    expect(rest.results.map((r) => r.id)).toEqual(['v4', 'v5'])
    expect(rest.truncated).toBe(false)
  })

  it('summary detail omits explanations; full keeps them', async () => {
    const args = { assertions: [{ id: 'eq', type: 'equal_height', targets: [{ selector: '.card' }] }] }
    const summary = await run(args)
    expect(byId(summary, 'eq').explanation).toBeUndefined()
    expect(byId(summary, 'eq').measured).toBeDefined()
    const full = await run({ ...args, detail: 'full' })
    expect(byId(full, 'eq').explanation).toContain('412')
  })

  it('supports role+name targeting via the accessibility tree', async () => {
    const env = await run({
      assertions: [
        { id: 'role-ok', type: 'visible', targets: [{ role: 'button', name: 'Save' }] },
        { id: 'role-miss', type: 'visible', targets: [{ role: 'button', name: 'NoSuchButton' }] },
      ],
    })
    const ok = byId(env, 'role-ok')
    expect(ok.verdict).toBe('PASS')
    expect(ok.error).toBeUndefined()
    expect(byId(env, 'role-miss')).toMatchObject({ verdict: 'ERROR', error: 'TARGET_NOT_FOUND' })
  })

  it('measures scrolled pages in document coordinates', async () => {
    // Body is 1600px tall in an 800px viewport: scrolling to (0,800) puts
    // #offscreen (doc y 1500-1540) IN view and #card-a (doc y 20-432) OUT of it.
    const { cdp } = session.context()
    await cdp.send('Runtime.evaluate', { expression: 'window.scrollTo(0, 800)' })
    try {
      const env = await run({
        detail: 'full',
        assertions: [
          { id: 'vp-off', type: 'within_viewport', targets: [{ selector: '#offscreen' }] },
          { id: 'vis-off', type: 'visible', targets: [{ selector: '#offscreen' }] },
          { id: 'vp-a', type: 'within_viewport', targets: [{ selector: '#card-a' }] },
          { id: 'vis-a', type: 'visible', targets: [{ selector: '#card-a' }] },
          {
            id: 'bg-off',
            type: 'color_near',
            targets: [{ selector: '#offscreen' }],
            params: { property: 'background', value: '#dddddd' },
          },
        ],
      })
      expect(byId(env, 'vp-off').verdict).toBe('PASS')
      expect(byId(env, 'vis-off').verdict).toBe('PASS')
      expect(byId(env, 'vp-a').verdict).toBe('FAIL')
      const visA = byId(env, 'vis-a')
      expect(visA.verdict).toBe('FAIL')
      expect(visA.explanation).toContain('outside')
      // The painted sample must come from the scrolled viewport, not doc (x,y).
      const bg = byId(env, 'bg-off')
      expect(bg.verdict).toBe('PASS')
      expect((bg.measured as { method: string }).method).toContain('painted')
    } finally {
      await cdp.send('Runtime.evaluate', { expression: 'window.scrollTo(0, 0)' })
    }
  })

  it('not_clipped honors the containing-block chain', async () => {
    const env = await run({
      detail: 'full',
      assertions: [
        // position:absolute escapes its STATIC overflow:hidden ancestor up to
        // the position:relative containing block — no clip applies.
        { id: 'escape', type: 'not_clipped', targets: [{ selector: '#abs-escape' }] },
        // …but a clipping ancestor that IS the containing block still clips.
        { id: 'caged', type: 'not_clipped', targets: [{ selector: '#caged' }] },
      ],
    })
    const escape = byId(env, 'escape')
    expect(escape.verdict).toBe('PASS')
    expect(escape.error).toBeUndefined()
    const caged = byId(env, 'caged')
    expect(caged.verdict).toBe('FAIL')
    expect((caged.measured as { exceed: { right: number } }).exceed.right).toBe(30)
    expect(caged.explanation).toContain('overflow:hidden')
  })

  it('not_overlapped ignores paint-empty overlays but keeps real occluders', async () => {
    // #portal (transparent fixed inset-0 div, last in body) covers everything
    // yet paints nothing — it must never appear as an occluder.
    const env = await run({
      detail: 'full',
      assertions: [
        { id: 'base', type: 'not_overlapped', targets: [{ selector: '#base' }] },
        { id: 'sized', type: 'not_overlapped', targets: [{ selector: '#sized' }] },
      ],
    })
    const base = byId(env, 'base')
    expect(base.verdict).toBe('FAIL')
    expect(base.explanation).toContain('#badge')
    expect((base.measured as { candidates_above: number }).candidates_above).toBe(1)
    expect(base.offending_uids).toHaveLength(2) // the target + #badge; no portal uid
    const sized = byId(env, 'sized')
    expect(sized.verdict).toBe('PASS')
    expect((sized.measured as { candidates_above: number }).candidates_above).toBe(0)
  })

  it('visible passes for border-only boxes; size_equals sees through transforms', async () => {
    const env = await run({
      assertions: [
        // #rule paints purely via its 2px top border (zero-height content box).
        { id: 'rule', type: 'visible', targets: [{ selector: '#rule' }] },
        // #scaled: content-box 100x50 under scale(2) → painted content box 200x100.
        {
          id: 'scaled',
          type: 'size_equals',
          targets: [{ selector: '#scaled' }],
          params: { width_px: 200, height_px: 100 },
        },
      ],
    })
    const rule = byId(env, 'rule')
    expect(rule.verdict).toBe('PASS')
    expect((rule.measured as { border_box: { width: number; height: number } }).border_box).toMatchObject({
      width: 100,
      height: 2,
    })
    const scaled = byId(env, 'scaled')
    expect(scaled.verdict).toBe('PASS')
    expect(scaled.measured).toMatchObject({ width: 200, height: 100 })
  })

  it('samples painted pixels correctly under deviceScaleFactor 2 emulation', async () => {
    try {
      await session.setViewport(1280, 800, 2)
      const env = await run({
        assertions: [
          {
            id: 'bg',
            type: 'color_near',
            targets: [{ selector: '#swatch' }],
            params: { property: 'background', value: '#ff0000' },
          },
        ],
      })
      const bg = byId(env, 'bg')
      expect(bg.verdict).toBe('PASS')
      expect((bg.measured as { method: string }).method).toContain('painted')
    } finally {
      await session.setViewport(1280, 800, 1)
    }
  })

  it('rejects a call with neither assertions nor suite_id', async () => {
    await expect(run({})).rejects.toThrow(/assertions.*suite_id/s)
  })
})
