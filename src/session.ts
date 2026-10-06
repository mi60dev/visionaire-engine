/**
 * Browser session lifecycle: launch/attach Chrome, enable CDP domains,
 * wire uid + stylesheet + script registries to navigation. SPEC §4 (connect), §11, §14.1.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import puppeteer from 'puppeteer-core'
import { settlePage, type SettleResult } from './settle.js'
import type { Browser, CDPSession, LaunchOptions, Page, Protocol } from 'puppeteer-core'
import { ScriptRegistry } from './attribution/scripts.js'
import { ExtensionCdpTransport, type AttachInfo } from './bridge/cdp-transport.js'
import { LiteSession } from './bridge/lite.js'
import type { BridgeClient, BridgeServer } from './bridge/server.js'
import type { BridgeTab } from './bridge/protocol.js'
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

/**
 * DOM.pushNodesByBackendIdsToFrontend fails with "Document needs to be requested first"
 * until DOM.getDocument has run in this session — and every navigation invalidates it.
 * uids minted via Runtime/DOMSnapshot would otherwise be unresolvable as a session's
 * first DOM call (field report: first solve in a fresh extension session).
 */
async function requestDocument(cdp: CDPSession): Promise<void> {
  await cdp.send('DOM.getDocument', { depth: 0 }).catch(() => {})
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

/**
 * Attach mode drives a browser over its DevTools endpoint; an off-host endpoint would let a
 * prompt-injected agent connect puppeteer anywhere. Loopback only unless explicitly allowed.
 */
export function assertLoopbackDebugUrl(url: string): void {
  if (process.env['VISIONAIRE_ALLOW_REMOTE_ATTACH'] === '1') return
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    throw new Error(`browserUrl is not a valid URL: ${url}`)
  }
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) {
    throw new Error(
      `browserUrl must point at this machine (127.0.0.1/localhost), got ${host}. ` +
        'Set VISIONAIRE_ALLOW_REMOTE_ATTACH=1 in the MCP server env to allow remote DevTools endpoints.',
    )
  }
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
  // WSL/Docker give Chrome a tiny /dev/shm; under load it crashes AT LAUNCH
  // ("Failed to launch the browser process ... Code: null"). Writing shared
  // memory to /tmp instead costs a little perf and removes a whole crash class.
  if (process.platform === 'linux') args.push('--disable-dev-shm-usage')
  const extra = process.env['VISIONAIRE_CHROME_ARGS']
  if (extra) args.push(...extra.split(/\s+/).filter(Boolean))
  return args
}

/**
 * Does this launch-failure text look like the sandbox was the blocker?
 * Ubuntu 24.04 AppArmor and userns restrictions kill Chrome with messages that
 * never contain the word "sandbox" — match those shapes too. Exported for tests.
 */
export function isSandboxBlocked(msg: string): boolean {
  return /sandbox|SUID|namespace|Operation not permitted|clone\(|EPERM|PERMISSION_DENIED|unshare/i.test(msg)
}

const LAUNCH_HINTS =
  '\nTroubleshooting:\n' +
  '  • transient crash (WSL memory pressure): simply retry connect; increase WSL memory in .wslconfig if frequent\n' +
  '  • sandbox blocked (Ubuntu 24.04 AppArmor/userns): set VISIONAIRE_NO_SANDBOX=1 in the MCP server env\n' +
  '  • missing shared libraries: sudo apt-get install -y libnss3 libatk-bridge2.0-0 libgbm1 libasound2\n' +
  '  • to see the FULL Chrome stderr, run from the repo:  npm run demo -- https://example.com --selector h1\n' +
  '  • extra flags: VISIONAIRE_CHROME_ARGS, e.g. "--single-process" as a last resort in minimal containers'

/**
 * Launch Chrome with two safety nets: a no-sandbox retry when the failure looks
 * sandbox-shaped, and a single plain retry for transient startup crashes
 * (intermittent "Code: null" kills under WSL/Docker memory pressure).
 */
async function launchChrome(base: LaunchOptions): Promise<Browser> {
  const args = baseLaunchArgs()
  try {
    return await puppeteer.launch({ ...base, args })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (isSandboxBlocked(msg) && process.env['VISIONAIRE_SANDBOX'] !== '1' && !args.includes('--no-sandbox')) {
      console.error(
        '[visionaire] Chrome could not start its sandbox (common on WSL/Docker/Ubuntu-24.04) — retrying with ' +
          '--no-sandbox. Set VISIONAIRE_NO_SANDBOX=1 to make this the default, or VISIONAIRE_SANDBOX=1 ' +
          'to keep the sandbox and fail instead.',
      )
      try {
        return await puppeteer.launch({ ...base, args: [...args, ...NO_SANDBOX_ARGS] })
      } catch (err2) {
        throw enrich(err2)
      }
    }
    // Transient startup crash (OOM kill, race) — one plain retry after a beat.
    console.error('[visionaire] browser launch failed once — retrying (transient startup crashes are common on WSL):')
    console.error(`[visionaire]   ${msg.split('\n')[0]}`)
    await new Promise((r) => setTimeout(r, 300))
    try {
      return await puppeteer.launch({ ...base, args })
    } catch (err2) {
      throw enrich(err2)
    }
  }

  function enrich(err: unknown): Error {
    const msg = err instanceof Error ? err.message : String(err)
    return new Error(msg + LAUNCH_HINTS)
  }
}

export type SessionMode = 'launch' | 'attach' | 'extension'

export interface ConnectOptions {
  mode?: SessionMode
  url?: string
  /** Extension mode: inspect this already-shared tab instead of the most recent one. */
  tabId?: number
  /** Extension mode: prefer this browser when several extensions are connected. */
  browser?: 'chrome' | 'firefox'
  browserUrl?: string
  headless?: boolean
  width?: number
  height?: number
}

/** How long connect({mode:'extension'}) waits for the extension to dial in (MV3 workers wake on a 30s alarm). */
const EXTENSION_WAIT_MS = Math.max(1_000, Number(process.env['VISIONAIRE_EXTENSION_WAIT_MS']) || 35_000)

/** How navigate/reload wait after `load`: settle cap and/or a selector to wait for. */
export interface SettleOptions {
  timeoutMs?: number
  selector?: string
}

export class SessionManager {
  private browser?: Browser
  private ctx?: ToolContext
  private mode: SessionMode = 'launch'
  /** Firefox extension sessions: DOM/CSSOM collector instead of CDP. */
  private liteSession?: LiteSession
  /** Extension-mode bookkeeping, for status lines. */
  private extensionTab?: { client: BridgeClient; tabId: number; owned: boolean }
  /** Set when an extension session ended underneath us (user cancelled the debug bar, tab closed…). */
  private lostReason?: string
  /** True once connect() was called in this process — auto-resume only covers a fresh (restarted) server. */
  private everConnected = false

  constructor(readonly bridge?: BridgeServer) {}

  /**
   * A restarted MCP server holds no browser session, yet the user's paired extension redials it within
   * seconds (field report 2026-10-06: the client restarted the server mid-task; the next call failed with
   * "Not connected"). When nothing was ever connected in this process and a paired CDP extension is already
   * connected, reattach to the agent's own tab (else the shared active tab) and say so.
   * Returns a note for the tool output, or undefined when nothing was resumed.
   */
  async autoResume(): Promise<string | undefined> {
    // Concurrent first calls share one attempt rather than racing two connects.
    this.resuming ??= this.tryResume().finally(() => {
      this.resuming = undefined
    })
    return this.resuming
  }

  private resuming?: Promise<string | undefined>

  private async tryResume(): Promise<string | undefined> {
    if (this.ctx || this.liteSession || this.everConnected) return undefined
    const bridge = this.bridge
    if (!bridge?.listening) return undefined
    const client = await bridge.waitForClient(1_500)
    if (!client || !client.caps.includes('cdp')) return undefined
    const tabs = await client.listTabs().catch(() => [])
    const owned = tabs.filter((t) => t.owned)
    const shared = tabs.filter((t) => t.shared)
    const pick = owned[owned.length - 1] ?? shared.find((t) => t.active) ?? shared[shared.length - 1]
    if (!pick) return undefined
    await this.connect({ mode: 'extension', tabId: pick.tabId })
    return (
      `note: no browser session in this server process (it was restarted) — reattached automatically to the paired ` +
      `${client.label}, tab ${pick.tabId}${pick.title ? ` "${pick.title.slice(0, 60)}"` : ''}. Earlier uids are stale.`
    )
  }

  get currentMode(): SessionMode {
    return this.mode
  }

  /** Non-undefined when the active session is a Firefox (lite) extension session. */
  get lite(): LiteSession | undefined {
    return this.liteSession
  }

  get lostSessionReason(): string | undefined {
    return this.lostReason
  }

  get connected(): boolean {
    return !!this.ctx || !!this.liteSession
  }

  /** One line describing the live session (for tool output). */
  describe(): string {
    if (this.liteSession) return `extension/${this.liteSession.client.browser} tab ${this.liteSession.tabId} (lite: DOM/CSSOM)`
    if (this.extensionTab) return `extension/${this.extensionTab.client.browser} tab ${this.extensionTab.tabId} (full CDP)`
    return this.mode
  }

  async connect(opts: ConnectOptions = {}): Promise<ToolContext | undefined> {
    await this.disconnect()
    this.lostReason = undefined
    this.everConnected = true

    if (opts.mode === 'extension') return this.connectExtension(opts)

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
      assertLoopbackDebugUrl(opts.browserUrl)
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
      this.ctx = await this.initPage(page)
      if (opts.url) await this.navigate(opts.url)
      return this.ctx
    } catch (err) {
      await this.disconnect().catch(() => {})
      throw err
    }
  }

  /** Open the engine's CDP session on a page and wire the uid/stylesheet/script registries. */
  private async initPage(page: Page): Promise<ToolContext> {
    {
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
      await requestDocument(cdp)
      await cdp.send('Overlay.enable')

      // A page-side alert()/confirm()/prompt() blocks every evaluate-family CDP
      // call indefinitely — auto-dismiss so tools can never dead-lock on a dialog.
      // beforeunload is accepted (allows navigation to proceed).
      cdp.on('Page.javascriptDialogOpening', (ev: Protocol.Page.JavascriptDialogOpeningEvent) => {
        void cdp
          .send('Page.handleJavaScriptDialog', {
            // In the user's own browser, never accept beforeunload: that would discard their unsaved work.
            accept: ev.type === 'beforeunload' && this.mode !== 'extension',
          })
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

      return { page, cdp, uids, sheets, scripts }
    }
  }

  // ───────────────────────── extension bridge ─────────────────────────

  private async connectExtension(opts: ConnectOptions): Promise<ToolContext | undefined> {
    const bridge = this.bridge
    if (!bridge || !bridge.listening) {
      throw new Error(
        `The extension bridge is not running${bridge?.startError ? ` (${bridge.startError})` : ''}. ` +
          'It starts with the MCP server unless VISIONAIRE_BRIDGE=0; set VISIONAIRE_BRIDGE_PORT to move it.',
      )
    }
    const client = await this.waitForPairedClient(bridge, opts.browser)
    if (!client) throw new Error(extensionMissingHelp(bridge))

    const { tabId, owned, needsNav } = await this.pickTab(client, opts)
    this.mode = 'extension'

    if (!client.caps.includes('cdp')) {
      // Firefox: no DevTools Protocol for extensions — DOM/CSSOM collector instead.
      this.liteSession = new LiteSession(client, tabId)
      if (opts.url && needsNav) await this.liteSession.navigate(opts.url)
      this.extensionTab = { client, tabId, owned }
      return undefined
    }

    try {
      const info = await client.request<AttachInfo>('cdp.attach', { tabId }).catch((err: Error) => {
        if (/restricted by policy|host access/i.test(err.message)) {
          throw new Error(
            `${err.message} — this browser is managed by an organization policy that blocks extension debugging on this site ` +
              '(Chrome 155+). Use mode "launch" (a separate local Chrome) instead.',
          )
        }
        throw err
      })
      const transport = new ExtensionCdpTransport(client, tabId, info)
      const browser = await puppeteer.connect({ transport, defaultViewport: null, protocolTimeout: 30_000 })
      browser.on('disconnected', () => {
        if (this.browser !== browser) return
        const why = transport.detachReason
        this.lostReason =
          why === 'canceled_by_user'
            ? 'the user clicked Cancel on Chrome\'s "started debugging this browser" bar'
            : why === 'target_closed'
              ? 'the inspected tab was closed'
              : why?.startsWith('origin_not_approved:')
                ? `the tab navigated to ${why.slice(20)}, which the user has not approved for the agent (the extension detached). ` +
                  'Ask the user to allow that site when the extension prompts, or connect with a url on an approved site'
                : why ?? 'the extension connection dropped'
        this.ctx = undefined
        this.browser = undefined
        this.extensionTab = undefined
      })
      this.browser = browser
      const page = (await browser.pages())[0]
      if (!page) throw new Error('the extension attached but exposed no page target')
      this.ctx = await this.initPage(page)
      this.extensionTab = { client, tabId, owned }
      if (opts.url && needsNav) await this.navigate(opts.url)
      return this.ctx
    } catch (err) {
      await this.disconnect().catch(() => {})
      throw err
    }
  }

  /**
   * A paired extension usually answers within a second. An unpaired one is connected
   * but waiting (bridge.unpairedWaiting) — no point waiting, it needs a pairing code.
   * Nothing at all may mean an MV3 worker asleep until its 30s alarm: wait longer.
   */
  private async waitForPairedClient(bridge: BridgeServer, prefer?: 'chrome' | 'firefox'): Promise<BridgeClient | undefined> {
    const quick = await bridge.waitForClient(3_000, prefer)
    if (quick || bridge.unpairedWaiting > 0) return quick
    const deadline = Date.now() + EXTENSION_WAIT_MS
    while (Date.now() < deadline) {
      const c = await bridge.waitForClient(2_000, prefer)
      if (c || bridge.unpairedWaiting > 0) return c
    }
    return undefined
  }

  private async pickTab(
    client: BridgeClient,
    opts: ConnectOptions,
  ): Promise<{ tabId: number; owned: boolean; needsNav: boolean }> {
    const tabs = await client.listTabs()
    if (opts.tabId !== undefined) {
      const t = tabs.find((x) => x.tabId === opts.tabId)
      if (!t) throw new Error(`tab ${opts.tabId} is not shared with the agent (visible: ${tabs.map((x) => x.tabId).join(', ') || 'none'})`)
      return { tabId: t.tabId, owned: t.owned, needsNav: true }
    }
    if (opts.url) {
      // Reuse the agent's own tab rather than piling up a new one per connect.
      const mine = tabs.filter((t) => t.owned)
      const reuse = mine[mine.length - 1]
      if (reuse) return { tabId: reuse.tabId, owned: true, needsNav: true }
      const tab = await client.request<BridgeTab>('tabs.open', { url: opts.url })
      // CDP clients open about:blank and navigate after attaching; lite clients load the url directly.
      return { tabId: tab.tabId, owned: true, needsNav: client.caps.includes('cdp') }
    }
    const shared = tabs.filter((t) => t.shared)
    const pick = shared.find((t) => t.active) ?? shared[shared.length - 1] ?? tabs[tabs.length - 1]
    if (!pick) {
      throw new Error(
        `Connected to the ${client.label}, but no tab is shared with the agent. Either pass url (the extension ` +
          'opens it in a new tab in the user\'s browser) or ask the user to click "Share this tab" in the Visionaire extension popup.',
      )
    }
    return { tabId: pick.tabId, owned: pick.owned, needsNav: false }
  }

  /** Status of the extension bridge, for the connect tool's output. */
  bridgeStatus(): string {
    const b = this.bridge
    if (!b) return 'extension bridge: disabled'
    if (!b.listening) return `extension bridge: not listening (${b.startError ?? 'disabled'})`
    const clients = b.clients()
    return `extension bridge: ws://127.0.0.1:${b.port} — ${clients.length ? clients.map((c) => c.label).join(', ') : 'no extension connected'}`
  }

  /**
   * Disable the browser cache for the rest of the session — fresh CSS/JS on every
   * load (field report: a stale cached stylesheet survived normal navigations).
   */
  async disableCache(): Promise<void> {
    if (this.liteSession) return // lite reloads pass bypassCache to tabs.reload instead
    const { cdp } = this.context()
    await cdp.send('Network.enable')
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  }

  /** Reload the current page (optionally ignoring the cache), with the same registry resync as navigate(). */
  async reload(ignoreCache = false, settle: SettleOptions = {}): Promise<SettleResult | undefined> {
    if (this.liteSession) {
      await this.liteSession.reload(ignoreCache)
      return undefined
    }
    const { page, cdp } = this.context()
    if (ignoreCache) await this.disableCache()
    await page.reload({ waitUntil: 'load' })
    const settled = await settlePage(page, settle)
    await cdp.send('CSS.disable')
    await cdp.send('CSS.enable')
    await cdp.send('Debugger.disable')
    await enableDebugger(cdp)
    await requestDocument(cdp)
    return settled
  }

  /** Load url, then wait for the page to settle (SPA routes render after `load`) — see settle.ts. */
  async navigate(url: string, settle: SettleOptions = {}): Promise<SettleResult | undefined> {
    if (this.liteSession) {
      await this.liteSession.navigate(url)
      return undefined
    }
    const { page, cdp } = this.context()
    await page.goto(url, { waitUntil: 'load' })
    const settled = await settlePage(page, settle)
    // Deterministic registry resync: the frameNavigated handler's fire-and-forget toggles
    // may still be in flight when goto resolves; awaited toggles here guarantee both
    // registries are fully populated before any tool call that follows a navigate.
    await cdp.send('CSS.disable')
    await cdp.send('CSS.enable')
    await cdp.send('Debugger.disable')
    await enableDebugger(cdp)
    await requestDocument(cdp)
    return settled
  }

  async setViewport(width: number, height: number, deviceScaleFactor?: number): Promise<void> {
    if (this.liteSession) {
      throw new Error(
        'set_viewport needs the DevTools Protocol, which Firefox does not give extensions. Resize the browser window ' +
          'manually, or use Chrome (full CDP) for responsive debugging.',
      )
    }
    const { page } = this.context()
    await page.setViewport({ width, height, deviceScaleFactor: deviceScaleFactor ?? 1 })
  }

  context(): ToolContext {
    if (!this.ctx) {
      if (this.lostReason) {
        throw new Error(`The extension session ended: ${this.lostReason}. Call connect again to resume.`)
      }
      if (this.liteSession) {
        throw new Error(
          'This step needs the DevTools Protocol, which Firefox does not give extensions (lite session). ' +
            'Use the lite diagnostics solve offers here, or connect via Chrome for the full engine.',
        )
      }
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
    this.liteSession = undefined
    this.extensionTab = undefined

    if (ctx) {
      ctx.uids.clear()
      ctx.sheets.clear()
      ctx.scripts?.clear()
      await ctx.cdp.detach().catch(() => {})
    }
    if (browser) {
      // Launched browsers are ours to kill; attached/extension ones belong to the user
      // (extension: disconnect closes the transport, which detaches chrome.debugger).
      if (this.mode === 'launch') await browser.close().catch(() => {})
      else await browser.disconnect().catch(() => {})
    }
  }
}

function extensionMissingHelp(bridge: BridgeServer): string {
  const { code, expiresInSec } = bridge.openPairing()
  const waiting = bridge.unpairedWaiting > 0
  return (
    (waiting
      ? 'The Visionaire extension is connected but not paired with this machine yet.\n'
      : `No paired Visionaire extension connected to ws://127.0.0.1:${bridge.port}.\n`) +
    `PAIRING CODE: ${code}   (one-time, valid ${Math.round(expiresInSec / 60)} min)\n` +
    'Tell the user, exactly:\n' +
    (waiting
      ? ''
      : '  • If the extension is not installed: run `npm run build:extension` in the visionaire-engine repo, then\n' +
        '    Chrome/Edge/Brave: chrome://extensions → Developer mode → Load unpacked → extension/dist/chrome\n' +
        '    Firefox: about:debugging#/runtime/this-firefox → Load Temporary Add-on → extension/dist/firefox/manifest.json\n') +
    `  • Click the Visionaire toolbar icon, paste the code ${code} next to "${bridge.info.project}", press Pair.\n` +
    'Then call connect again. (Alternatives: mode "launch" for a fresh local Chrome, or "attach" with browserUrl.)'
  )
}
