/**
 * Real Firefox + the BUILT Firefox extension (lite backend). Skips when no
 * Firefox is installed (FIREFOX_PATH overrides discovery).
 *
 * Pairing: WebDriver BiDi cannot open moz-extension:// pages, so the popup's
 * Approve click (covered by the Chrome e2e — shared code) is replaced by seeding
 * the token into the profile's JSON extension storage.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer, { type Browser } from 'puppeteer-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BridgeServer } from '../src/bridge/server.js'
import { SessionManager } from '../src/session.js'
import { solveTool } from '../src/tools/solve.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.join(here, 'fixtures')
const extDir = path.resolve(here, '..', 'extension', 'dist', 'firefox')
const GECKO_ID = 'visionaire-bridge@mi60dev'

function findFirefox(): string | undefined {
  const candidates = [
    process.env['FIREFOX_PATH'],
    '/Applications/Firefox.app/Contents/MacOS/firefox',
    '/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox',
    '/Applications/Firefox Nightly.app/Contents/MacOS/firefox',
    '/usr/bin/firefox',
  ]
  return candidates.find((p): p is string => !!p && fs.existsSync(p))
}
// On CI (Ubuntu's snap Firefox can't use puppeteer's temp profiles) this is opt-in: VISIONAIRE_E2E_FIREFOX=1.
const firefox = process.env['CI'] && process.env['VISIONAIRE_E2E_FIREFOX'] !== '1' ? undefined : findFirefox()

describe.skipIf(!firefox)('extension bridge — real Firefox (lite)', () => {
  let fixtureServer: http.Server
  let base = ''
  let bridge: BridgeServer
  let browser: Browser
  let session: SessionManager
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vz-home-'))
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vz-ffprof-'))
  let busy = ''

  beforeAll(async () => {
    process.env['VISIONAIRE_HOME'] = home
    fixtureServer = http.createServer((req, res) => {
      const f = path.join(fixtures, new URL(req.url ?? '/', 'http://x').pathname)
      if (!f.startsWith(fixtures) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return void res.writeHead(404).end()
      res.writeHead(200, { 'content-type': f.endsWith('.css') ? 'text/css' : 'text/html' })
      fs.createReadStream(f).pipe(res)
    })
    await new Promise<void>((r) => fixtureServer.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(fixtureServer.address() as { port: number }).port}`

    bridge = new BridgeServer({ project: 'firefox-e2e', port: 17490 })
    expect(await bridge.start()).toBeGreaterThan(0)
    const { loadOrCreateToken } = await import('../src/bridge/token.js')
    const store = path.join(profile, 'browser-extension-data', GECKO_ID)
    fs.mkdirSync(store, { recursive: true })
    fs.writeFileSync(path.join(store, 'storage.js'), JSON.stringify({ token: loadOrCreateToken(), basePort: 17490 }))

    try {
      browser = await puppeteer.launch({
        browser: 'firefox',
        executablePath: firefox,
        headless: true,
        userDataDir: profile,
        extraPrefsFirefox: { 'extensions.webextensions.ExtensionStorageIDB.enabled': false },
      })
    } catch (err) {
      // macOS hands a second launch of an already-open Firefox to the running instance.
      const running = spawnSync('pgrep', ['-f', firefox!]).stdout.toString().trim()
      if (running && /WS endpoint URL/.test(String(err))) {
        busy = 'this Firefox is already open — quit it to run the Firefox e2e'
        return
      }
      throw err
    }
    await browser!.installExtension(extDir)
    expect(await bridge.waitForClient(40_000, 'firefox')).toBeTruthy()
    session = new SessionManager(bridge)
  }, 120_000)

  afterAll(async () => {
    await session?.disconnect().catch(() => {})
    await browser?.close().catch(() => {})
    await bridge?.stop()
    fixtureServer?.close()
    delete process.env['VISIONAIRE_HOME']
    for (const d of [home, profile]) fs.rmSync(d, { recursive: true, force: true })
  })

  it('connects in lite mode and opens the url in an agent tab', async (t) => {
    if (busy) return t.skip()
    const ctx = await session.connect({ mode: 'extension', url: `${base}/cascade.html` })
    expect(ctx).toBeUndefined() // no CDP context in Firefox
    expect(session.describe()).toMatch(/extension\/firefox tab \d+ \(lite/)
    expect(await session.lite!.url()).toContain('cascade.html')
  })

  it('solve answers with the cascade winner and file:line from CSSOM', async (t) => {
    if (busy) return t.skip()
    const res = await solveTool(session).handler(undefined as never, {
      intent: 'why is there 24px margin under the Get started link',
      context: { element: 'Get started link' },
    })
    expect(res.text).toContain('(lite)')
    expect(res.text).toMatch(/margin-bottom = 24px\n {2}WINNER \.hero-cta \.btn → .*theme\.css:10/)
    expect(res.text).toMatch(/plugin\.css:5 — lower specificity/)
    expect(res.text).toMatch(/padding-top, padding-right, padding-bottom, padding-left = 12px \| 28px \| 12px \| 28px/)
  })

  it('snapshot flags an ignored z-index and fences page text', async (t) => {
    if (busy) return t.skip()
    const res = await solveTool(session).handler(undefined as never, { intent: 'overview', scenario: 'page-overview' })
    expect(res.text).toMatch(/div#promo-banner "Limited offer" .*z-index:9999 IGNORED\(position:static\)/)
    expect(res.text).toContain('<page-data untrusted="true"')
  })

  it('takes a screenshot and states CDP-only tools are unavailable', async (t) => {
    if (busy) return t.skip()
    const shot = await session.lite!.screenshot()
    expect(shot.images?.[0]?.data.length).toBeGreaterThan(1000)
    const r = await solveTool(session).handler(undefined as never, { intent: 'x', tool: 'get_listeners', args: { selector: 'a' } })
    expect(r.text).toMatch(/unavailable in Firefox/)
  })
})
