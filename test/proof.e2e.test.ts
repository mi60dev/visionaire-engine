/**
 * capture_proof e2e — real Chrome, headless, file:// fixture.
 *
 * Uses fixtures/sweep.html at the default 1280x800 launch viewport, where the
 * two .card elements are equal height (suite PASS). Proof flow under test:
 * BEFORE capture (suite PASS) → break the card heights via a style mutation →
 * AFTER capture (suite FAIL) → verdict_delta records the flip. Files land in a
 * scratch VISIONAIRE_ARTIFACTS_DIR, never in the repo.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findChromeExecutable, SessionManager } from '../src/session.js'
import { captureProofTool } from '../src/tools/capture-proof.js'
import { assertVisualTool } from '../src/tools/assert-visual.js'
import type { ToolResult } from '../src/types.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureUrl = (name: string): string => pathToFileURL(path.resolve(here, 'fixtures', name)).href

const chromePath = findChromeExecutable()

interface ProofEnvelope {
  summary: string
  bundle_id: string
  phase: 'before' | 'after'
  artifacts: Array<{ kind: string; path: string }>
  verdict_delta?: {
    before: string
    after: string
    changed_assertions: Array<{ id: string; before: string; after: string }>
  }
  warnings?: string[]
  truncated: boolean
}

describe.skipIf(!chromePath)('capture_proof e2e — real Chrome', () => {
  const session = new SessionManager()
  let artifactsBase = ''

  beforeAll(async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'visionaire-proof-'))
    artifactsBase = path.join(scratch, 'artifacts')
    process.env['VISIONAIRE_ARTIFACTS_DIR'] = artifactsBase
    process.env['VISIONAIRE_SUITE_DIR'] = path.join(scratch, 'suites')
    process.env['VISIONAIRE_MARKER_DIR'] = path.join(scratch, 'marker')
    await session.connect({ mode: 'launch', headless: true })
    await session.navigate(fixtureUrl('sweep.html'))
    await assertVisualTool.handler(session.context(), {
      assertions: [{ id: 'cards-equal', type: 'equal_height', targets: [{ selector: '.card' }] }],
      suite_id: 'proof-suite',
    })
  })

  afterAll(async () => {
    await session.disconnect()
  })

  const run = (args: Record<string, unknown>): Promise<ToolResult> =>
    captureProofTool.handler(session.context(), args)
  const parse = (res: ToolResult): ProofEnvelope => JSON.parse(res.text) as ProofEnvelope

  it('before phase writes the screenshot + verdicts to the bundle (paths, not base64)', async () => {
    const res = await run({
      phase: 'before',
      bundle_id: 'proof-test',
      targets: [{ selector: '.card' }],
      suite_id: 'proof-suite',
    })
    const env = parse(res)
    expect(env.bundle_id).toBe('proof-test')
    expect(env.phase).toBe('before')
    expect(env.truncated).toBe(false)
    expect(env.verdict_delta).toBeUndefined()
    expect(env.summary).toContain("Bundle 'proof-test' BEFORE captured")
    expect(env.summary).toContain('suite PASS')

    // The image is a file path in the artifacts dir — never base64 in the envelope.
    expect(res.images).toBeUndefined()
    expect(env.artifacts).toHaveLength(1)
    expect(env.artifacts[0]!.kind).toBe('annotated_screenshot')
    expect(env.artifacts[0]!.path.endsWith(path.join('bundles', 'proof-test', 'before.png'))).toBe(true)
    expect(fs.existsSync(env.artifacts[0]!.path)).toBe(true)
    expect(fs.statSync(env.artifacts[0]!.path).size).toBeGreaterThan(0)

    const verdictsPath = path.join(path.dirname(env.artifacts[0]!.path), 'before.verdicts.json')
    expect(fs.existsSync(verdictsPath)).toBe(true)
    const stored = JSON.parse(fs.readFileSync(verdictsPath, 'utf8')) as { verdict: string }
    expect(stored.verdict).toBe('PASS')
  })

  it('after phase reports verdict_delta once a mutation breaks the suite', async () => {
    // Break: explicit unequal heights defeat flex stretch → equal_height FAILs.
    const ctx = session.context()
    await ctx.cdp.send('Runtime.evaluate', {
      expression:
        "(() => { document.querySelector('.card--a').style.height = '150px'; " +
        "document.querySelector('.card--b').style.height = '260px'; })()",
      returnByValue: true,
    })

    const res = await run({
      phase: 'after',
      bundle_id: 'proof-test',
      suite_id: 'proof-suite',
      note: 'after breaking card heights',
    })
    const env = parse(res)
    expect(env.phase).toBe('after')
    expect(env.warnings).toBeUndefined()
    expect(env.verdict_delta).toBeDefined()
    expect(env.verdict_delta!.before).toBe('PASS')
    expect(env.verdict_delta!.after).toBe('FAIL')
    expect(env.verdict_delta!.changed_assertions).toEqual([{ id: 'cards-equal', before: 'PASS', after: 'FAIL' }])
    expect(env.summary).toContain('suite now FAIL (was PASS)')
    expect(env.summary).toContain('after breaking card heights')
    expect(env.artifacts[0]!.path.endsWith('after.png')).toBe(true)
    expect(fs.existsSync(env.artifacts[0]!.path)).toBe(true)

    // The full bundle now sits on disk: both phases, images + verdicts.
    const dir = path.join(artifactsBase, 'bundles', 'proof-test')
    for (const f of ['before.png', 'before.verdicts.json', 'after.png', 'after.verdicts.json']) {
      expect(fs.existsSync(path.join(dir, f)), `${f} should exist`).toBe(true)
    }
  })

  it('after without a before phase still captures but warns BUNDLE_PHASE_MISSING', async () => {
    const res = await run({ phase: 'after', bundle_id: 'proof-nobefore', suite_id: 'proof-suite' })
    const env = parse(res)
    expect(env.verdict_delta).toBeUndefined()
    expect(env.warnings).toBeDefined()
    expect(env.warnings!.join(' ')).toContain('BUNDLE_PHASE_MISSING')
    // Still captured — the screenshot exists even without a delta.
    expect(fs.existsSync(env.artifacts[0]!.path)).toBe(true)
  })

  it('before phase without suite_id captures the screenshot, no verdicts file, no warnings', async () => {
    const res = await run({ phase: 'before', bundle_id: 'proof-nosuite' })
    const env = parse(res)
    expect(env.warnings).toBeUndefined()
    expect(env.verdict_delta).toBeUndefined()
    const dir = path.join(artifactsBase, 'bundles', 'proof-nosuite')
    expect(fs.existsSync(path.join(dir, 'before.png'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'before.verdicts.json'))).toBe(false)
  })

  it('after WITH suite_id against a suiteless before warns instead of producing a delta', async () => {
    const res = await run({ phase: 'after', bundle_id: 'proof-nosuite', suite_id: 'proof-suite' })
    const env = parse(res)
    expect(env.verdict_delta).toBeUndefined()
    expect(env.warnings).toBeDefined()
    expect(env.warnings!.join(' ')).toContain(
      'before phase has no stored verdicts (captured without suite_id) — delta unavailable',
    )
    expect(fs.existsSync(env.artifacts[0]!.path)).toBe(true)
  })

  it('suiteful before then after WITHOUT suite_id warns to pass suite_id, no delta', async () => {
    await run({ phase: 'before', bundle_id: 'proof-suiteless-after', suite_id: 'proof-suite' })
    const res = await run({ phase: 'after', bundle_id: 'proof-suiteless-after' })
    const env = parse(res)
    expect(env.verdict_delta).toBeUndefined()
    expect(env.warnings).toBeDefined()
    expect(env.warnings!.join(' ')).toContain(
      'pass suite_id to compare against the stored before verdicts — delta unavailable',
    )
  })

  it('an unresolvable mark target degrades to a warning, not an aborted capture', async () => {
    const res = await run({
      phase: 'before',
      bundle_id: 'proof-gonetarget',
      targets: [{ selector: '.error-badge-gone' }, { selector: '.card' }],
    })
    const env = parse(res)
    // The capture still lands — the missing target is reported, the rest are marked.
    expect(env.artifacts).toHaveLength(1)
    expect(fs.existsSync(env.artifacts[0]!.path)).toBe(true)
    expect(env.warnings).toBeDefined()
    expect(env.warnings!.join(' ')).toContain("target '.error-badge-gone' did not resolve — not marked")
  })

  it('rejects a path-traversal bundle_id before touching the page', async () => {
    await expect(run({ phase: 'before', bundle_id: '../evil' })).rejects.toThrow(/bundle_id/)
  })

  it('unknown suite_id throws SUITE_NOT_FOUND', async () => {
    await expect(run({ phase: 'before', bundle_id: 'proof-badsuite', suite_id: 'no-such-suite' })).rejects.toThrow(
      /SUITE_NOT_FOUND/,
    )
  })
})
