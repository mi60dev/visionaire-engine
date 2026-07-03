/**
 * inject_css — the live fix loop (field-report ask #1): trial declarations on the
 * live page, see what changed, revert cleanly. No source files touched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SessionManager, findChromeExecutable } from '../src/session.js'
import { injectCssTool } from '../src/tools/inject-css.js'
import { evaluateTool } from '../src/tools/evaluate.js'
import type { ToolContext } from '../src/types.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureUrl = pathToFileURL(path.join(here, 'fixtures', 'cascade.html')).href
const hasChrome = !!findChromeExecutable()

async function computedOf(ctx: ToolContext, selector: string, prop: string): Promise<string> {
  const res = await evaluateTool.handler(ctx, {
    expression: `getComputedStyle(document.querySelector(${JSON.stringify(selector)})).getPropertyValue(${JSON.stringify(prop)})`,
  })
  return res.text.trim().replace(/^"|"$/g, '')
}

describe.skipIf(!hasChrome)('inject_css e2e — live fix loop', () => {
  let session: SessionManager
  let ctx: ToolContext

  beforeAll(async () => {
    session = new SessionManager()
    ctx = await session.connect({ mode: 'launch', headless: true, url: fixtureUrl })
  }, 60_000)

  afterAll(async () => {
    await session?.disconnect()
  })

  it('trials declarations on a target and reports the computed change', async () => {
    const res = await injectCssTool.handler(ctx, {
      selector: '.btn',
      declarations: 'margin-bottom: 99px',
    })
    expect(res.text).toContain('patch p')
    expect(res.text).toMatch(/margin-bottom: .* → 99px/)
    expect(res.text).toContain('LIVE TRIAL')
    expect(await computedOf(ctx, '.btn', 'margin-bottom')).toBe('99px')
  })

  it('beats even a fixture !important rule (trials are !important)', async () => {
    // letter-spacing on .btn is 1px !important in the fixture (plugin.css:7).
    await injectCssTool.handler(ctx, { selector: '.btn', declarations: 'letter-spacing: 7px' })
    expect(await computedOf(ctx, '.btn', 'letter-spacing')).toBe('7px')
  })

  it('injects a raw page-wide rule block', async () => {
    const res = await injectCssTool.handler(ctx, {
      css: '#promo-banner { display: none }',
    })
    expect(res.text).toContain('page-wide rule block')
    expect(await computedOf(ctx, '#promo-banner', 'display')).toBe('none')
  })

  it("revert: 'all' restores the served CSS", async () => {
    const res = await injectCssTool.handler(ctx, { revert: 'all' })
    expect(res.text).toMatch(/reverted \d+ patch/)
    expect(await computedOf(ctx, '.btn', 'margin-bottom')).not.toBe('99px')
    expect(await computedOf(ctx, '#promo-banner', 'display')).not.toBe('none')
  })

  it('validates its modes', async () => {
    await expect(injectCssTool.handler(ctx, {})).rejects.toThrow(/exactly one of/i)
    await expect(injectCssTool.handler(ctx, { declarations: 'color: red' })).rejects.toThrow(/need a target/i)
  })
})
