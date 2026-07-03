/**
 * Blast radius + scoped-fix suggestion — the core "Change the button font-size
 * to 15px" scenario: the winning rule is `button {…}`, and editing it would
 * change EVERY button. explain_styles must say so and offer a scoped selector.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SessionManager, findChromeExecutable } from '../src/session.js'
import { explainStylesTool } from '../src/tools/explain-styles.js'
import type { ToolContext } from '../src/types.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureUrl = pathToFileURL(path.join(here, 'fixtures', 'blast.html')).href
const hasChrome = !!findChromeExecutable()

describe.skipIf(!hasChrome)('explain_styles — blast radius & scoped fix', () => {
  let session: SessionManager
  let ctx: ToolContext

  beforeAll(async () => {
    session = new SessionManager()
    ctx = await session.connect({ mode: 'launch', headless: true, url: fixtureUrl })
  }, 60_000)

  afterAll(async () => {
    await session?.disconnect()
  })

  it('warns that the winning rule styles other elements too', async () => {
    const res = await explainStylesTool.handler(ctx, { selector: '#cta', property: 'font-size' })
    expect(res.text).toContain("blast radius: winner 'button' also styles 2 other elements")
    expect(res.text).toMatch(/e\.g\. <button\.btn\.save>/)
    expect(res.text).toContain('editing that rule changes them all')
  })

  it('suggests a scoped selector that uniquely targets the element and beats the winner', async () => {
    const res = await explainStylesTool.handler(ctx, { selector: '#cta', property: 'font-size' })
    expect(res.text).toContain("to change ONLY this element: use '#cta'")
    expect(res.text).toMatch(/spec\(1,0,0\) beats winner spec\(0,0,1\)/)
  })

  it('stays silent when the winner already targets only this element', async () => {
    const res = await explainStylesTool.handler(ctx, { selector: '#cta', property: 'background-color' })
    expect(res.text).not.toContain('blast radius')
    expect(res.text).toContain('WINNER  #cta')
  })
})
