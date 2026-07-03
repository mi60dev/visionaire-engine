/**
 * Browser session lifecycle: launch/attach Chrome, enable CDP domains,
 * wire uid + stylesheet + script registries to navigation. SPEC §4 (connect), §11, §14.1.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import puppeteer from 'puppeteer-core'
import type { Browser, CDPSession, LaunchOptions, Page, Protocol } from 'puppeteer-core'
import { ScriptRegistry } from './attribution/scripts.js'
import { StylesheetRegistry } from './attribution/stylesheets.js'
import type { ToolContext } from './types.js'
import { UidRegistry } from './uid.js'

const MACOS_CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
]

const LINUX_CHROME_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']

/**
 * Resolve a Chrome/Chrome-for-Testing binary inside a puppeteer browser cache, or
 * undefined. `@puppeteer/browsers install chrome` lays the cache out as
 *   <baseDir>/<version>/<platform>/<binary>
 * e.g. `~/.cache/puppeteer/chrome/mac_arm-132.0.6834.110/chrome-mac-arm64/Google Chrome for Testing.app/…`
 * (verified empirically on this machine). The <platform> segment carries an arch
 * suffix that varies (mac-arm64 | mac-x64 | linux64 | win64), so we read it back
 * rather than hardcode it. Versions sort descending (string) so the newest wins.
 * Dependency-free (no glob lib); every fs call is guarded so a torn/foreign cache
 * layout degrades to undefined instead of throwing.
 */
export function findPuppeteerCachedChrome(baseDir: string): string | undefined {
  let versions: string[]
  try {
    versions = fs.readdirSync(baseDir)
  } catch {
    return undefined // baseDir missing or unreadable
  }
  // Newest version wins by descending string sort (e.g. 132.* before 131.*).
  versions.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))

  for (const version of versions) {
    const versionDir = path.join(baseDir, version)
    let platformDirs: string[]
    try {
      platformDirs = fs.readdirSync(versionDir)
    } catch {
      continue // not a directory / unreadable — skip
    }
    for (const platformDir of platformDirs) {
      const root = path.join(versionDir, platformDir)
      const binary =
        process.platform === 'darwin'
          ? path.join(root, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
          : process.platform === 'win32'
            ? path.join(root, 'chrome.exe')
            : path.join(root, 'chrome')
      try {
        if (fs.existsSync(binary)) return binary
      } catch {
        // fall through to the next platform/version
      }
    }
  }
  return undefined
}

/** Puppeteer cache roots to scan, honoring $PUPPETEER_CACHE_DIR, else ~/.cache/puppeteer/chrome. */
function puppeteerCacheChromeDirs(): string[] {
  const dirs: string[] = []
  const override = process.env['PUPPETEER_CACHE_DIR']
  if (override) dirs.push(path.join(override, 'chrome'))
  try {
    dirs.push(path.join(os.homedir(), '.cache', 'puppeteer', 'chrome'))
  } catch {
    // homedir() can throw in exotic environments — the override (if any) still stands.
  }
  return dirs
}

/**
 * Debugger.enable must always be followed by setSkipAllPauses: with the domain
 * enabled, a page-side `debugger;` statement would otherwise freeze the tab —
 * and the skip flag does NOT survive a Debugger.disable/enable toggle
 * (verified empirically), so every re-enable re-sets it.
 */
async function enableDebugger(cdp: CDPSession): Promise<void> {
  await cdp.send('Debugger.enable')
  await cdp.send('Debugger.setSkipAllPauses', { skip: true })
}

export function findChromeExecutable(): string | undefined {
  const envPath = process.env['CHROME_PATH']
  if (envPath && fs.existsSync(envPath)) return envPath

  // A system Chrome always wins first (below); the puppeteer cache is the last-resort
  // fallback so a `@puppeteer/browsers install` cold-start "just works" (field report #5).
  const systemChrome = findSystemChrome()
  if (systemChrome) return systemChrome

  for (const baseDir of puppeteerCacheChromeDirs()) {
    const cached = findPuppeteerCachedChrome(baseDir)
    if (cached) return cached
  }
  return undefined
}

/** Standard OS install locations for a real Chrome/Chromium (no puppeteer cache). */
function findSystemChrome(): string | undefined {
  if (process.platform === 'darwin') {
    return MACOS_CHROME_PATHS.find((p) => fs.existsSync(p))
  }

  if (process.platform === 'win32') {
    const bases = [
      process.env['PROGRAMFILES'] ?? 'C:\\Program Files',
      process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)',
      process.env['LOCALAPPDATA'],
    ]
    for (const base of bases) {
      if (!base) continue
      const candidate = path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe')
      if (fs.existsSync(candidate)) return candidate
    }
    return undefined
  }

  for (const name of LINUX_CHROME_NAMES) {
    const res = spawnSync('which', [name], { encoding: 'utf8' })
    const found = res.status === 0 ? res.stdout.trim() : ''
    if (found && fs.existsSync(found)) return found
  }
  return undefined
}

const NO_SANDBOX_ARGS = ['--no-sandbox', '--disable-setuid-sandbox']

/**
 * Chrome's sandbox can't initialize as root or in many WSL/Docker setups. We keep
 * the sandbox ON by default (visionaire visits untrusted pages) and only force it
 * off when it genuinely can't work (root) or the user opts in. When a normal launch
 * fails specifically on the sandbox, launchChrome() retries once with it disabled
 * and logs the downgrade — so it "just works" on WSL without silently weakening
 * isolation everywhere.
 */
function baseLaunchArgs(): string[] {
  const args: string[] = []
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
  const forceSandbox = process.env['VISIONAIRE_SANDBOX'] === '1'
  const forceNoSandbox = process.env['VISIONAIRE_NO_SANDBOX'] === '1'
  if (forceNoSandbox || (isRoot && !forceSandbox)) args.push(...NO_SANDBOX_ARGS)
  const extra = process.env['VISIONAIRE_CHROME_ARGS']
  if (extra) args.push(...extra.split(/\s+/).filter(Boolean))
  return args
}

/** Launch Chrome, retrying once without the sandbox if that's what blocked it (WSL/Docker). */
async function launchChrome(base: LaunchOptions): Promise<Browser> {
  const args = baseLaunchArgs()
  try {
    return await puppeteer.launch({ ...base, args })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const sandboxBlocked = /sandbox|SUID|namespace/i.test(msg)
    if (sandboxBlocked && process.env['VISIONAIRE_SANDBOX'] !== '1' && !args.includes('--no-sandbox')) {
      console.error(
        '[visionaire] Chrome could not start its sandbox (common on WSL/Docker) — retrying with ' +
          '--no-sandbox. Set VISIONAIRE_NO_SANDBOX=1 to make this the default, or VISIONAIRE_SANDBOX=1 ' +
          'to keep the sandbox and fail instead.',
      )
      return await puppeteer.launch({ ...base, args: [...args, ...NO_SANDBOX_ARGS] })
    }
    throw err
  }
}

export interface ConnectOptions {
  mode?: 'launch' | 'attach'
  url?: string
  browserUrl?: string
  headless?: boolean
  width?: number
  height?: number
}

export class SessionManager {
  private browser?: Browser
  private ctx?: ToolContext
  private mode: 'launch' | 'attach' = 'launch'

  async connect(opts: ConnectOptions = {}): Promise<ToolContext> {
    await this.disconnect()

    const mode = opts.mode ?? (opts.browserUrl ? 'attach' : 'launch')
    const width = opts.width ?? 1280
    const height = opts.height ?? 800

    let browser: Browser
    if (mode === 'attach') {
      if (!opts.browserUrl) {
        throw new Error(
          'attach mode requires browserUrl (e.g. "http://127.0.0.1:9222" — start Chrome with --remote-debugging-port=9222).',
        )
      }
      // null viewport: keep the real window size of the browser we attach to.
      // protocolTimeout: a CDP call that never resolves must error fast, not hang
      // the tool call (field report: 4-minute client-side MCP timeouts).
      browser = await puppeteer.connect({
        browserURL: opts.browserUrl,
        defaultViewport: null,
        protocolTimeout: 30_000,
      })
    } else {
      const executablePath = findChromeExecutable()
      if (!executablePath) {
        throw new Error(
          'No Chrome/Chromium found. puppeteer-core does not bundle a browser — install one, then retry.\n' +
            'Auto-checked: $CHROME_PATH, standard OS install locations, and the puppeteer browser cache ' +
            '($PUPPETEER_CACHE_DIR or ~/.cache/puppeteer/chrome).\n' +
            '  • Debian/Ubuntu/WSL: download Google Chrome and `sudo apt-get install -y ./google-chrome-stable_current_amd64.deb`\n' +
            '    (from https://www.google.com/chrome/) — apt pulls in the required system libraries.\n' +
            '  • or: `npx @puppeteer/browsers install chrome@stable` — the cached binary is then discovered automatically.\n' +
            '  • or point CHROME_PATH at any existing Chrome/Chromium binary.\n' +
            '  • or use mode:"attach" with browserUrl against a Chrome started with --remote-debugging-port.',
        )
      }
      browser = await launchChrome({
        executablePath,
        headless: opts.headless ?? false,
        defaultViewport: { width, height },
        protocolTimeout: 30_000,
        // We own SIGINT/SIGTERM in index.ts; puppeteer's handlers call process.exit
        // before the MCP transport can shut down cleanly.
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      })
    }

    this.browser = browser
    this.mode = mode

    try {
      const pages = await browser.pages()
      const page: Page = pages[0] ?? (await browser.newPage())
      if (mode === 'attach' && (opts.width !== undefined || opts.height !== undefined)) {
        await page.setViewport({ width, height })
      }

      const cdp = await page.createCDPSession()
      const uids = new UidRegistry()
      const sheets = new StylesheetRegistry()
      const scripts = new ScriptRegistry()

      // CSS.enable requires the DOM domain; attach the registry before enabling
      // CSS so the styleSheetAdded replay is not missed. A second CSS.enable
      // (if attach() already enabled it) is a no-op, and the registry dedupes
      // by styleSheetId.
      await cdp.send('DOM.enable')
      await cdp.send('Page.enable')
      await sheets.attach(cdp)
      await cdp.send('CSS.enable')
      // Same discipline for JS: Debugger.enable replays already-parsed scripts
      // via scriptParsed (verified empirically), so attach the registry first.
      await scripts.attach(cdp)
      await enableDebugger(cdp)
      await cdp.send('DOMSnapshot.enable')
      await cdp.send('Overlay.enable')

      // A page-side alert()/confirm()/prompt() blocks every evaluate-family CDP
      // call indefinitely — auto-dismiss so tools can never dead-lock on a dialog.
      // beforeunload is accepted (allows navigation to proceed).
      cdp.on('Page.javascriptDialogOpening', (ev: Protocol.Page.JavascriptDialogOpeningEvent) => {
        void cdp
          .send('Page.handleJavaScriptDialog', { accept: ev.type === 'beforeunload' })
          .catch(() => {})
        console.error(`[visionaire] auto-dismissed page dialog (${ev.type}): ${ev.message.slice(0, 80)}`)
      })

      cdp.on('Page.frameNavigated', (event: Protocol.Page.FrameNavigatedEvent) => {
        // Main frame only (no parentId). backendNodeIds and styleSheetIds are per-document.
        // frameNavigated can arrive AFTER the new document's styleSheetAdded replay, so a bare
        // clear() may wipe fresh sheets; toggling CSS re-emits styleSheetAdded for every live
        // sheet, making the registry converge regardless of event order. The Debugger toggle
        // mirrors this for scripts: re-enable replays live scripts with the same scriptIds.
        if (!event.frame.parentId) {
          uids.clear()
          sheets.clear()
          scripts.clear()
          void cdp
            .send('CSS.disable')
            .then(() => cdp.send('CSS.enable'))
            .catch(() => {
              // Session tearing down mid-navigation — nothing to resync.
            })
          void cdp
            .send('Debugger.disable')
            .then(() => enableDebugger(cdp))
            .catch(() => {
              // Session tearing down mid-navigation — nothing to resync.
            })
        }
      })

      this.ctx = { page, cdp, uids, sheets, scripts }
      if (opts.url) await this.navigate(opts.url)
      return this.ctx
    } catch (err) {
      await this.disconnect().catch(() => {})
      throw err
    }
  }

  async navigate(url: string): Promise<void> {
    const { page, cdp } = this.context()
    await page.goto(url, { waitUntil: 'load' })
    // Deterministic registry resync: the frameNavigated handler's fire-and-forget toggles
    // may still be in flight when goto resolves; awaited toggles here guarantee both
    // registries are fully populated before any tool call that follows a navigate.
    await cdp.send('CSS.disable')
    await cdp.send('CSS.enable')
    await cdp.send('Debugger.disable')
    await enableDebugger(cdp)
  }

  async setViewport(width: number, height: number, deviceScaleFactor?: number): Promise<void> {
    const { page } = this.context()
    await page.setViewport({ width, height, deviceScaleFactor: deviceScaleFactor ?? 1 })
  }

  context(): ToolContext {
    if (!this.ctx) {
      throw new Error(
        'Not connected to a browser. Call the "connect" tool first — mode "launch" starts a local Chrome; ' +
          'mode "attach" with browserUrl joins a running one.',
      )
    }
    return this.ctx
  }

  async disconnect(): Promise<void> {
    const browser = this.browser
    const ctx = this.ctx
    this.browser = undefined
    this.ctx = undefined

    if (ctx) {
      ctx.uids.clear()
      ctx.sheets.clear()
      ctx.scripts?.clear()
      await ctx.cdp.detach().catch(() => {})
    }
    if (browser) {
      // Launched browsers are ours to kill; attached ones belong to the user.
      if (this.mode === 'launch') await browser.close().catch(() => {})
      else await browser.disconnect().catch(() => {})
    }
  }
}
