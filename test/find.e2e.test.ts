/**
 * find_elements e2e — real Chrome, headless, file:// fixture (cascade.html).
 *
 * Field-report ask #6: strict AND made over-specifying return empty, and hidden /
 * stale targets caused churn. These tests pin the forgiving behaviors:
 *   - match:'any' unions criteria instead of intersecting them;
 *   - visibleOnly:false surfaces display:none elements (visibleOnly:true hides them);
 *   - the empty-result message names the recovery levers.
 *
 * cascade.html is EXTENDED for these tests with one hidden element:
 *   <button class="hidden-action" style="display:none">Secret action</button>
 * alongside its pre-existing visible <a class="btn">Get started</a>.
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findChromeExecutable, SessionManager } from '../src/session.js'
import { findElementsTool } from '../src/tools/find-elements.js'
import type { ToolContext } from '../src/types.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureUrl = pathToFileURL(path.join(here, 'fixtures', 'cascade.html')).href
const hasChrome = !!findChromeExecutable()

describe.skipIf(!hasChrome)('find_elements — forgiving matching (ask #6)', () => {
  let session: SessionManager
  let ctx: ToolContext

  beforeAll(async () => {
    session = new SessionManager()
    ctx = await session.connect({ mode: 'launch', headless: true, url: fixtureUrl })
  }, 60_000)

  afterAll(async () => {
    await session?.disconnect()
  })

  const run = (args: Record<string, unknown>): Promise<string> =>
    findElementsTool.handler(ctx, args).then((r) => r.text)

  it('match:"all" (default) intersects: the .btn does not contain "Limited offer"', async () => {
    // '.btn' is the "Get started" link; "Limited offer" lives in #promo-banner.
    // AND-combined, they contradict → no match.
    const text = await run({ selector: '.btn', text: 'Limited offer' })
    expect(text).toMatch(/no elements matched/i)
  })

  it('match:"any" unions the SAME two criteria into both elements', async () => {
    const text = await run({ selector: '.btn', text: 'Limited offer', match: 'any' })
    // Union surfaces the .btn (selector arm) AND #promo-banner (text arm).
    expect(text).toMatch(/\d+ elements? found/i)
    expect(text).toContain('<a.btn>')
    expect(text).toContain('#promo-banner')
    // Two distinct uids, one per matched element.
    const uids = [...text.matchAll(/^(e\d+) /gm)].map((m) => m[1])
    expect(new Set(uids).size).toBeGreaterThanOrEqual(2)
  })

  it('match:"any" still respects visibleOnly: the hidden button is filtered out by default', async () => {
    // role button OR text "Secret" both point only at the display:none button here.
    const text = await run({ role: 'button', text: 'Secret', match: 'any' })
    expect(text).toMatch(/no elements matched/i)
    expect(text).not.toContain('hidden-action')
  })

  it('visibleOnly:false surfaces a display:none element that visibleOnly:true hides', async () => {
    const hidden = await run({ selector: '.hidden-action', visibleOnly: true })
    expect(hidden).toMatch(/no elements matched/i)

    const shown = await run({ selector: '.hidden-action', visibleOnly: false })
    expect(shown).toMatch(/1 element found/i)
    expect(shown).toContain('<button.hidden-action>')
    expect(shown).toContain('Secret action')
  })

  it('visibleOnly:false works in match:"any" too — union includes the hidden button', async () => {
    // .btn (visible) OR role button (the hidden one): with visibleOnly off, both appear.
    const text = await run({ selector: '.btn', role: 'button', match: 'any', visibleOnly: false })
    expect(text).toContain('<a.btn>')
    expect(text).toContain('<button.hidden-action>')
  })

  it('the empty-result message points at match:"any" when over-specifying with AND', async () => {
    const text = await run({ selector: '.btn', text: 'Limited offer' })
    // Names the two forgiving levers the field report asked us to surface.
    expect(text).toMatch(/match:"any"/)
    expect(text).toMatch(/visibleOnly:false/)
    // And still nudges toward grounding (page_snapshot / near-miss help).
    expect(text).toMatch(/page_snapshot|Did you mean/i)
  })

  it('the empty-result message drops the match:"any" hint when already in union mode', async () => {
    const text = await run({ text: 'no-such-text-anywhere-zzz', match: 'any' })
    expect(text).toMatch(/no elements matched/i)
    // Already union — do not tell the caller to switch to match:"any"; still offers visibleOnly.
    expect(text).not.toMatch(/loosen to match:"any"/)
    expect(text).toMatch(/visibleOnly:false/)
    expect(text).toMatch(/page_snapshot/i)
  })
})
