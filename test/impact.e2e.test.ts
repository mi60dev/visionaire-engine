/**
 * impact_preview e2e — real Chrome over the impact.html fixture: 23 .nav-item
 * elements split header/middle/footer, plus a sandboxed padding dry-run where
 * #special.nav-item { padding: 4px !important } must survive untouched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SessionManager, findChromeExecutable } from '../src/session.js'
import { impactPreviewTool } from '../src/tools/impact-preview.js'
import { resolveTarget } from '../src/uid.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureUrl = (name: string): string => pathToFileURL(path.resolve(here, 'fixtures', name)).href
const chromePath = findChromeExecutable()

interface ChangedRow {
  uid: string
  prop: string
  before: string
  after: string
}

interface Envelope {
  summary: string
  match_count: number
  groups: Array<{ key: string; count: number; uids: string[]; region: string; sample_identity: string }>
  dry_run?: {
    would_change_count: number
    unaffected_count: number
    changed: ChangedRow[]
    method: string
    notes?: string[]
  }
  artifacts?: Array<{ kind: string; path: string }>
  notes?: string[]
  truncated: boolean
  next_offset?: number
}

describe.skipIf(!chromePath)('impact_preview e2e — real Chrome', () => {
  const session = new SessionManager()

  beforeAll(async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'visionaire-impact-'))
    process.env['VISIONAIRE_ARTIFACTS_DIR'] = path.join(scratch, 'artifacts')
    process.env['VISIONAIRE_SUITE_DIR'] = path.join(scratch, 'suites')
    await session.connect({ mode: 'launch', headless: true })
    await session.navigate(fixtureUrl('impact.html'))
  })

  afterAll(async () => {
    await session.disconnect()
  })

  it('reports the true match_count (23) with the scope-honesty sentence', async () => {
    const res = await impactPreviewTool.handler(session.context(), { selector: '.nav-item' })
    const env = JSON.parse(res.text) as Envelope
    expect(env.match_count).toBe(23)
    expect(env.summary).toContain("'.nav-item' matches 23 elements")
    expect(env.summary).toContain('impact is computed for the currently open page at the current viewport only')
    expect(env.summary).toContain('responsive_sweep')
  })

  it('groups matches into header/footer/sidebar visual roles across 3 regions', async () => {
    const res = await impactPreviewTool.handler(session.context(), { selector: '.nav-item' })
    const env = JSON.parse(res.text) as Envelope
    expect(env.summary).toContain('3 visual roles, 3 screen regions')
    expect(env.groups.map((g) => [g.key, g.count])).toEqual([
      ['a.nav-item@bottom[role=link]', 9],
      ['a.nav-item@top[role=link]', 8],
      ['button.nav-item@middle[role=button]', 6],
    ])
    const total = env.groups.reduce((n, g) => n + g.uids.length, 0)
    expect(total).toBe(23)
    expect(env.groups[0]!.sample_identity).toBe('<a.nav-item>')
  })

  it('dry-runs {padding: 20px}: 22 elements change 8px→20px, the !important #special stays unaffected', async () => {
    const ctx = session.context()
    const first = await impactPreviewTool.handler(ctx, {
      selector: '.nav-item',
      proposed_change: { declarations: { padding: '20px' } },
      page: { offset: 0, limit: 100 },
    })
    const env = JSON.parse(first.text) as Envelope
    expect(env.dry_run).toBeDefined()
    expect(env.dry_run!.method).toBe('sandboxed inject_css + recompute')
    expect(env.dry_run!.would_change_count).toBe(22)
    expect(env.dry_run!.unaffected_count).toBe(1)
    // padding changed for >0 elements — no unsupported-declaration note.
    expect(env.dry_run!.notes ?? []).toEqual([])

    // changed rows are capped at 20 per page; fetch the remainder via next_offset.
    expect(env.dry_run!.changed).toHaveLength(20)
    expect(env.truncated).toBe(true)
    expect(env.next_offset).toBe(20)
    const second = await impactPreviewTool.handler(ctx, {
      selector: '.nav-item',
      proposed_change: { declarations: { padding: '20px' } },
      page: { offset: env.next_offset!, limit: 100 },
    })
    const env2 = JSON.parse(second.text) as Envelope
    expect(env2.dry_run!.changed).toHaveLength(2)
    expect(env2.truncated).toBe(false)

    const rows = [...env.dry_run!.changed, ...env2.dry_run!.changed]
    expect(rows).toHaveLength(22)
    for (const row of rows) {
      expect(row.prop).toBe('padding')
      expect(row.before).toBe('8px')
      expect(row.after).toBe('20px')
    }

    // #special is protected by #special.nav-item { padding: 4px !important }.
    const special = await resolveTarget(ctx, { selector: '#special' })
    expect(rows.map((r) => r.uid)).not.toContain(special.uid)
  })

  it('removes the injected style tag and leaves the live padding untouched', async () => {
    const ctx = session.context()
    await impactPreviewTool.handler(ctx, {
      selector: '.nav-item',
      proposed_change: { declarations: { padding: '20px' } },
    })
    const leftover = await ctx.cdp.send('Runtime.evaluate', {
      expression: "document.querySelectorAll('style[data-visionaire-impact]').length",
      returnByValue: true,
    })
    expect(leftover.result.value).toBe(0)
    const padding = await ctx.cdp.send('Runtime.evaluate', {
      expression: "getComputedStyle(document.querySelector('header .nav-item')).getPropertyValue('padding')",
      returnByValue: true,
    })
    expect(padding.result.value).toBe('8px')
  })

  it('flags declarations that change nothing as DRY_RUN_UNSUPPORTED_DECLARATION notes, not errors', async () => {
    // Every .nav-item already computes display from its own rules; 'padding: 8px'
    // equals the current computed value on 22 elements and loses to !important on
    // #special — zero changes, so the honest note must appear.
    const res = await impactPreviewTool.handler(session.context(), {
      selector: '.nav-item',
      proposed_change: { declarations: { padding: '8px' } },
    })
    const env = JSON.parse(res.text) as Envelope
    expect(env.dry_run!.would_change_count).toBe(0)
    expect(env.dry_run!.notes?.[0]).toContain("DRY_RUN_UNSUPPORTED_DECLARATION: 'padding: 8px'")
  })

  it('throws an actionable error for an invalid selector', async () => {
    await expect(impactPreviewTool.handler(session.context(), { selector: ':::nope' })).rejects.toThrow(
      /Invalid CSS selector: :::nope/,
    )
  })

  it('returns match_count 0 with empty groups for a selector with no matches (no error)', async () => {
    const res = await impactPreviewTool.handler(session.context(), { selector: '.does-not-exist' })
    const env = JSON.parse(res.text) as Envelope
    expect(env.match_count).toBe(0)
    expect(env.groups).toEqual([])
    expect(env.truncated).toBe(false)
    expect(env.summary).toContain('matches 0 elements')
  })

  it("detail 'full' saves an annotated screenshot artifact as a file path, never base64", async () => {
    const res = await impactPreviewTool.handler(session.context(), { selector: '.nav-item', detail: 'full' })
    const env = JSON.parse(res.text) as Envelope
    expect(res.images).toBeUndefined()
    expect(env.artifacts).toBeDefined()
    expect(env.artifacts![0]!.kind).toBe('annotated_screenshot')
    expect(env.artifacts![0]!.path).toMatch(/impact_\d{4}\.png$/)
    expect(fs.existsSync(env.artifacts![0]!.path)).toBe(true)
  })
})
