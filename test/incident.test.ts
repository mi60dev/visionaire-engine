/**
 * Pure parts of the 2026-10-06 incident fixes: read_text budgeting, page-change diff,
 * full-page screenshot budget, argument-shape errors, and when auto-resume may fire.
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { budgetText } from '../src/tools/read-text.js'
import { describePageChange, type PageState } from '../src/engine/page-change.js'
import { fullPageScale, FULL_PAGE_MAX_SIDE, FULL_PAGE_MAX_PIXELS } from '../src/engine/capture.js'
import { describeShape, schemaAt } from '../src/format/schema-shape.js'
import { clampSettle, DEFAULT_SETTLE_MS, MAX_SETTLE_MS } from '../src/settle.js'
import { SessionManager } from '../src/session.js'
import { TOOL_HANDLERS } from '../src/tools/solve.js'

describe('budgetText', () => {
  it('normalises whitespace but keeps rows and tab-separated cells', () => {
    const r = budgetText('  Watch\tMode  \r\n\n\n  Hero   banner\tPixel diff \n\n', 1000)
    expect(r.text).toBe('Watch\tMode\n\nHero banner\tPixel diff')
    expect(r.truncated).toBe(false)
  })

  it('marks truncation and cuts at a line break near the budget', () => {
    const raw = Array.from({ length: 50 }, (_, i) => `row ${i} ${'x'.repeat(20)}`).join('\n')
    const r = budgetText(raw, 300)
    expect(r.truncated).toBe(true)
    expect(r.text.length).toBeLessThanOrEqual(300)
    expect(r.text.endsWith('x')).toBe(true) // whole lines only
    expect(r.total).toBe(raw.length)
  })
})

describe('describePageChange', () => {
  const base: PageState = { url: 'https://a.test/r', title: 'Reports', dialogs: ['New report'], focus: null, nodes: 400, scrollY: 0 }

  it('says a dialog closed and elements were removed', () => {
    const after = { ...base, dialogs: [], nodes: 361 }
    expect(describePageChange(base, after)).toEqual(['dialog closed: "New report"', '39 elements removed'])
  })

  it('reports URL, focus and scroll changes', () => {
    const after = { ...base, url: 'https://a.test/x', focus: 'input#name', scrollY: 120 }
    expect(describePageChange(base, after)).toEqual([
      'URL changed: https://a.test/r → https://a.test/x',
      'focus: none → input#name',
      'page scrolled 0 → 120px',
    ])
  })

  it('is empty when nothing observable changed', () => {
    expect(describePageChange(base, { ...base })).toEqual([])
  })
})

describe('fullPageScale', () => {
  it('leaves normal pages at full size', () => {
    expect(fullPageScale(1280, 3000)).toBe(1)
  })

  it('fits a 28,000 px page under the side and pixel caps', () => {
    const s = fullPageScale(1280, 28_000)
    expect(s).toBeLessThan(1)
    expect(28_000 * s).toBeLessThanOrEqual(FULL_PAGE_MAX_SIDE)
    expect(1280 * s * 28_000 * s).toBeLessThanOrEqual(FULL_PAGE_MAX_PIXELS)
  })
})

describe('argument shape errors', () => {
  it('renders an object schema with optional fields', () => {
    const shape = { scope: z.object({ uid: z.string().optional(), x: z.number().optional() }).optional() }
    expect(describeShape(schemaAt(shape, ['scope'])!)).toBe('{ uid?: string, x?: number }')
  })

  it('names the expected page_snapshot scope shape', () => {
    const scope = schemaAt(TOOL_HANDLERS['page_snapshot']!.inputSchema, ['scope'])
    expect(scope).toBeDefined()
    expect(describeShape(scope!)).toMatch(/^\{ .*selector\?: string.*\}$/)
  })
})

describe('clampSettle', () => {
  it('defaults, clamps and allows 0', () => {
    expect(clampSettle(undefined)).toBe(DEFAULT_SETTLE_MS)
    expect(clampSettle(10 ** 9)).toBe(MAX_SETTLE_MS)
    expect(clampSettle(0)).toBe(0)
  })
})

describe('autoResume guards', () => {
  it('does nothing without a bridge', async () => {
    expect(await new SessionManager().autoResume()).toBeUndefined()
  })

  it('does nothing once connect was called in this process', async () => {
    const calls: string[] = []
    const bridge = {
      listening: true,
      port: 17337,
      unpairedWaiting: 1, // connect returns at once with pairing help instead of waiting 35 s
      info: { project: 'test' },
      openPairing: () => ({ code: 'AAAA-BBBB-CCCC', expiresInSec: 300 }),
      waitForClient: async () => {
        calls.push('wait')
        return undefined
      },
    }
    const s = new SessionManager(bridge as never)
    await s.connect({ mode: 'extension' }).catch(() => {}) // fails fast: no client — but marks the session as used
    calls.length = 0
    expect(await s.autoResume()).toBeUndefined()
    expect(calls).toEqual([])
  })

  it('ignores a lite (Firefox) client', async () => {
    const bridge = { listening: true, waitForClient: async () => ({ caps: ['dom'], listTabs: async () => [] }) }
    expect(await new SessionManager(bridge as never).autoResume()).toBeUndefined()
  })
})
