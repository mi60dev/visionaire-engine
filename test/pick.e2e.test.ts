/**
 * pick_element e2e — real Chrome, headless. The happy path drives the pick
 * with a synthetic Input.dispatchMouseEvent click while inspect mode is
 * active (exactly the mechanism SPEC §4 names for testing); the second test
 * exercises the friendly timeout at the minimum clamp.
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findChromeExecutable, SessionManager } from '../src/session.js'
import { pickElementTool } from '../src/tools/pick-element.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureUrl = (name: string): string => pathToFileURL(path.resolve(here, 'fixtures', name)).href

const chromePath = findChromeExecutable()

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe.skipIf(!chromePath)('pick_element e2e — real Chrome', () => {
  const session = new SessionManager()

  beforeAll(async () => {
    await session.connect({ mode: 'launch', headless: true })
    await session.navigate(fixtureUrl('cascade.html'))
  })

  afterAll(async () => {
    await session.disconnect()
  })

  it('resolves a synthetic click on the button to uid + chain + hint, prefixed with the headless warning', async () => {
    const ctx = session.context()

    const evaluated = await ctx.cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const r = document.querySelector('.hero-cta .btn').getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
      })()`,
      returnByValue: true,
    })
    const { x, y } = JSON.parse(String(evaluated.result.value)) as { x: number; y: number }

    // Start the pick WITHOUT awaiting, give inspect mode time to engage, then click.
    const pending = pickElementTool.handler(ctx, { timeoutSeconds: 30 })
    await sleep(300)
    // Inspect mode resolves the picked node from the hover state, so the click must
    // be preceded by a mouseMoved (a real user always hovers before clicking).
    await ctx.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await ctx.cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    })
    await ctx.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    })

    const res = await pending
    expect(res.text).toMatch(/^warning: headless/)
    expect(res.text).toMatch(/picked: e\d+ <a\.btn>/)
    expect(res.text).toContain('Get started')
    expect(res.text).toMatch(/chain: [^\n]*\bbody\b/)
    expect(res.text).toMatch(/next: explain_styles \{ uid: "e\d+" \} or inspect_element \{ uid: "e\d+" \}/)
  }, 20000)

  it('times out with a friendly message at the minimum clamp and exits inspect mode', async () => {
    const ctx = session.context()

    // 1 clamps to the 5s minimum; no click arrives.
    const res = await pickElementTool.handler(ctx, { timeoutSeconds: 1 })
    expect(res.text).toContain('warning: headless')
    expect(res.text).toContain('no element was picked within 5s')
    expect(res.text).toContain('is someone looking at the browser window?')
    expect(res.text).not.toContain('Error')

    // Follow-up CDP commands still work…
    const doc = await ctx.cdp.send('DOM.getDocument', { depth: 0 })
    expect(doc.root.nodeId).toBeGreaterThan(0)

    // …and inspect mode really exited: a hover+click now fires NO inspectNodeRequested.
    let fired = false
    const listener = (): void => {
      fired = true
    }
    ctx.cdp.on('Overlay.inspectNodeRequested', listener)
    try {
      await ctx.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 50, y: 50 })
      await ctx.cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: 50,
        y: 50,
        button: 'left',
        clickCount: 1,
      })
      await ctx.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: 50,
        y: 50,
        button: 'left',
        clickCount: 1,
      })
      await sleep(400)
    } finally {
      ctx.cdp.off('Overlay.inspectNodeRequested', listener)
    }
    expect(fired).toBe(false)
  }, 20000)
})
