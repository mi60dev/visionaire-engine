/**
 * interact e2e — DRIVE the UI to a state and LEAVE it there.
 *
 * The whole point of this tool (vs record_interaction) is state PERSISTENCE:
 * after clicking a trigger, the popup it opened is still open, so a FOLLOW-UP
 * inspect_element on that popup returns a real box model. The flagship test
 * below proves exactly that — interact then inspect, no re-open in between.
 *
 * Served over a local node:http server (mirrors interaction.e2e.test.ts); the
 * fixture is self-contained so file:// would also work, but http keeps the two
 * e2e suites identical.
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findChromeExecutable, SessionManager } from '../src/session.js'
import { interactTool } from '../src/tools/interact.js'
import { inspectElementTool } from '../src/tools/inspect-element.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixturesDir = path.resolve(here, 'fixtures')

const chromePath = findChromeExecutable()

describe.skipIf(!chromePath)('interact e2e — real Chrome over local http', () => {
  const session = new SessionManager()
  let server: http.Server
  let base: string

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const rel = (req.url === '/' ? '/popup.html' : (req.url ?? '/')).split('?')[0]!
      // path.join normalizes; the startsWith barrier rejects anything outside fixturesDir.
      const file = path.join(fixturesDir, rel)
      if (!file.startsWith(fixturesDir + path.sep)) {
        res.writeHead(403)
        res.end()
        return
      }
      let body: Buffer
      try {
        body = fs.readFileSync(file)
      } catch {
        res.writeHead(404)
        res.end()
        return
      }
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'
      res.writeHead(200, { 'content-type': type })
      res.end(body)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    await session.connect({ mode: 'launch', headless: true })
  })

  afterAll(async () => {
    await session.disconnect()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('click opens the popup and LEAVES it open — a follow-up inspect sees a real box', async () => {
    await session.navigate(`${base}/popup.html`)
    const ctx = session.context()

    // Precondition: before the click the popup has NO box model and is not visible.
    const before = await inspectElementTool.handler(ctx, { selector: '#popup' })
    expect(before.text).toMatch(/display-none/)
    expect(before.text).toContain('no box model — element is not rendered')

    // Act: click the trigger. interact reports the TRIGGER's post-action state
    // (it stays visible) and tells the agent to re-snapshot.
    const res = await interactTool.handler(ctx, { selector: '#trigger', action: 'click' })
    expect(res.text).toMatch(/^clicked e\d+ <button#trigger>/)
    expect(res.text).toContain('now visible')
    expect(res.text).toContain('take a fresh page_snapshot')

    // The WHOLE POINT: the popup is STILL OPEN. A fresh inspect_element on it now
    // returns a real box model and a visible verdict — state persisted, no re-open.
    const after = await inspectElementTool.handler(ctx, { selector: '#popup' })
    expect(after.text).not.toContain('no box model')
    expect(after.text).not.toMatch(/display-none/)
    // getBoxSummary reports the CONTENT box: the 400x300 border-box element is
    // box-sizing:border-box with 16px padding + 2px border, so content is 364x264.
    expect(after.text).toMatch(/box: content 364x264/)
    // header carries the visibility tag; the popup is now visible (text preview
    // may sit between the tag and the "— visible" marker)
    expect(after.text).toMatch(/<div#popup[^>]*>.*— visible/)
  }, 20000)

  it('interact itself reports the popup visible when the popup is the target', async () => {
    await session.navigate(`${base}/popup.html`)
    const ctx = session.context()

    // First open it via the trigger, then interact-hover the popup itself to read
    // back its post-action geometry directly from interact's own output.
    await interactTool.handler(ctx, { selector: '#trigger', action: 'click' })
    const res = await interactTool.handler(ctx, { selector: '#popup', action: 'hover', settleMs: 0 })
    expect(res.text).toMatch(/^hovered e\d+ <div#popup[^>]*>/)
    // content box of the border-box popup (see note above): 364x264
    expect(res.text).toContain('now visible 364x264')
  }, 20000)

  it('hover on the trigger leaves it visible and reports its box', async () => {
    await session.navigate(`${base}/popup.html`)
    const ctx = session.context()

    const res = await interactTool.handler(ctx, { selector: '#trigger', action: 'hover' })
    expect(res.text).toMatch(/^hovered e\d+ <button#trigger>/)
    expect(res.text).toContain('now visible')
  }, 20000)

  it('focus focuses the input and leaves it focused (document.activeElement persists)', async () => {
    await session.navigate(`${base}/popup.html`)
    const ctx = session.context()

    const res = await interactTool.handler(ctx, { selector: '#focusable', action: 'focus' })
    expect(res.text).toMatch(/^focused e\d+ <input#focusable>/)
    expect(res.text).toContain('now visible')

    // State persisted: the input is the active element after interact returns.
    const active = await ctx.cdp.send('Runtime.evaluate', {
      expression: 'document.activeElement && document.activeElement.id',
      returnByValue: true,
    })
    expect(active.result.value).toBe('focusable')
  }, 20000)
})
