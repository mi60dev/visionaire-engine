/**
 * Visionaire Bridge — background (Chrome MV3 service worker / Firefox MV2 page).
 *
 * Finds local Visionaire MCP servers (ws://127.0.0.1:17337 + peers it lists), pairs
 * with it (one-time code the agent shows the user), then serves its requests:
 *   Chrome  → DevTools Protocol for a tab via chrome.debugger ('cdp')
 *   Firefox → fixed DOM/CSSOM collector via content scripts ('lite')
 *
 * The agent is confined three ways:
 *   tabs   — only tabs it opened or tabs the user shared from the popup;
 *   sites  — only origins the user approved (dev hosts like localhost are pre-approved);
 *            a tab that navigates to an unapproved site is detached immediately;
 *   CDP    — only the protocol domains/methods the engine needs (no cookies, storage, browser).
 */
import { BRIDGE_PORT_SPAN, BRIDGE_PROTOCOL, DEFAULT_BRIDGE_PORT } from './protocol.js'
import { vzCollect } from './collector.js'

const api = globalThis.browser ?? globalThis.chrome
const IS_FIREFOX = typeof globalThis.browser !== 'undefined' && /firefox/i.test(navigator.userAgent)
const BROWSER = IS_FIREFOX ? 'firefox' : 'chrome'
const HAS_CDP = !!api.debugger
const CAPS = HAS_CDP ? ['cdp'] : ['lite']
const EXT_VERSION = api.runtime.getManifest().version
const PING_MS = 20_000 // MV3: a WebSocket message every <30s keeps the worker alive (Chrome 116+)
const APPROVAL_TIMEOUT_MS = 120_000

/** port → Conn */
const conns = new Map()
/** tabId → port of the server that attached the debugger */
const attached = new Map()
/** tabId → last committed main-frame URL we saw */
const tabUrls = new Map()
/** approval id → resolve(decision) */
const approvals = new Map()
let state = { token: null, allowOpen: true, openActive: true, sites: [], basePort: DEFAULT_BRIDGE_PORT, shared: [], owned: [], grants: {} }
let loaded = false

// ───────────────────────── persistence ─────────────────────────

async function load() {
  if (loaded) return
  const local = await api.storage.local.get(['token', 'allowOpen', 'openActive', 'sites', 'basePort'])
  // Must match VISIONAIRE_BRIDGE_PORT on the server side when that is changed.
  state.basePort = Number.isInteger(local.basePort) && local.basePort > 1023 && local.basePort < 65520 ? local.basePort : DEFAULT_BRIDGE_PORT
  state.token = local.token ?? null
  state.allowOpen = local.allowOpen ?? true
  state.openActive = local.openActive ?? true
  state.sites = Array.isArray(local.sites) ? local.sites : []
  // Tab grants are per browser session — never persisted across restarts.
  if (api.storage.session) {
    const s = await api.storage.session.get(['shared', 'owned', 'grants'])
    state.shared = s.shared ?? []
    state.owned = s.owned ?? []
    state.grants = s.grants ?? {}
  }
  loaded = true
}
async function saveTabs() {
  if (api.storage.session) await api.storage.session.set({ shared: state.shared, owned: state.owned, grants: state.grants })
}
const allowedTab = (tabId) => state.shared.includes(tabId) || state.owned.includes(tabId)

// ───────────────────────── site policy ─────────────────────────

function originOf(url) {
  try {
    const u = new URL(url)
    return u.protocol === 'file:' ? 'file://' : u.origin
  } catch {
    return null
  }
}
/** Local development hosts are pre-approved: debugging your own dev server is the point. */
function isDevHost(url) {
  try {
    const h = new URL(url).hostname
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost') || h.endsWith('.test')
  } catch {
    return false
  }
}
function schemeOk(url) {
  return url === 'about:blank' || /^(https?|file):/i.test(url)
}
function siteAllowed(tabId, url) {
  if (url === 'about:blank' || isDevHost(url)) return true
  const o = originOf(url)
  if (!o) return false
  return state.sites.includes(o) || (tabId != null && (state.grants[tabId] ?? []).includes(o))
}
async function grant(tabId, url) {
  const o = originOf(url)
  if (!o) return
  state.grants[tabId] = [...new Set([...(state.grants[tabId] ?? []), o])]
  await saveTabs()
}

/** Ask the user (small extension window) before the agent may load a site. */
async function askUser(url, why) {
  const id = nonce()
  const page = api.runtime.getURL(`approve.html?id=${id}&url=${encodeURIComponent(url)}&why=${encodeURIComponent(why)}`)
  const decision = new Promise((resolve) => {
    approvals.set(id, resolve)
    setTimeout(() => {
      if (approvals.delete(id)) resolve('deny')
    }, APPROVAL_TIMEOUT_MS)
  })
  try {
    await api.windows.create({ url: page, type: 'popup', width: 460, height: 340, focused: true })
  } catch {
    await api.tabs.create({ url: page, active: true })
  }
  return decision
}

/** Throws unless the user allows `url` for `tabId` (asks when needed). */
async function ensureSite(tabId, url, why) {
  if (!schemeOk(url)) throw new Error(`refusing ${String(url).slice(0, 40)} — only http(s) and file pages can be inspected`)
  if (siteAllowed(tabId, url)) return
  const decision = await askUser(url, why)
  if (decision === 'always') {
    state.sites = [...new Set([...state.sites, originOf(url)])]
    await api.storage.local.set({ sites: state.sites })
  } else if (decision === 'once') {
    if (tabId != null) await grant(tabId, url)
    else return 'grant-after-open'
  } else {
    throw new Error(`the user declined to let the agent open ${originOf(url)}`)
  }
}

/** A tab under inspection navigated: if the new site is not approved, cut the agent off at once. */
async function onTabNavigated(tabId, url) {
  tabUrls.set(tabId, url)
  if (!attached.has(tabId) || siteAllowed(tabId, url)) return
  const port = attached.get(tabId)
  attached.delete(tabId)
  await api.debugger.detach({ tabId }).catch(() => {})
  conns.get(port)?.emit('cdp.detached', { tabId, reason: `origin_not_approved:${originOf(url)}` })
}

// ───────────────────────── CDP policy ─────────────────────────

/** Protocol domains the engine (and puppeteer's page bootstrap) needs. Everything else is refused. */
const CDP_DOMAINS = new Set([
  'Accessibility', 'Animation', 'Audits', 'CSS', 'Debugger', 'DOM', 'DOMDebugger', 'DOMSnapshot', 'Emulation', 'Input',
  'Inspector', 'Log', 'Network', 'Overlay', 'Page', 'Performance', 'Runtime', 'Security', 'Target',
])
/** Within allowed domains: never cookies, response bodies, downloads, or new targets/contexts. */
const CDP_DENY = new Set([
  'Network.getCookies', 'Network.getAllCookies', 'Network.setCookie', 'Network.setCookies', 'Network.deleteCookies',
  'Network.clearBrowserCookies', 'Network.getResponseBody', 'Network.getResponseBodyForInterception',
  'Network.takeResponseBodyForInterceptionAsStream', 'Network.getRequestPostData', 'Network.searchInResponseBody',
  'Network.loadNetworkResource', 'Network.replayXHR', 'Network.setRequestInterception', 'Network.getCertificate',
  'Page.setDownloadBehavior', 'Page.getCookies', 'Page.deleteCookie', 'Page.captureSnapshot', 'Page.setWebLifecycleState',
  'Security.setIgnoreCertificateErrors', 'Security.setOverrideCertificateErrors',
  'Target.createTarget', 'Target.closeTarget', 'Target.createBrowserContext', 'Target.disposeBrowserContext',
  'Target.attachToBrowserTarget', 'Target.exposeDevToolsProtocol', 'Target.setRemoteLocations', 'Target.getTargets',
])
function cdpAllowed(method) {
  return CDP_DOMAINS.has(String(method).split('.')[0]) && !CDP_DENY.has(method)
}

// ───────────────────────── crypto ─────────────────────────

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
function nonce() {
  return hex(crypto.getRandomValues(new Uint8Array(16)))
}
const enc = new TextEncoder()
async function hmac(key, message) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(message)))
}
function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}
const normCode = (c) => String(c).toUpperCase().replace(/[^A-Z0-9]/g, '')
const b64 = (s) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0))
async function openToken(code, t, iv, box) {
  const key = await crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', enc.encode(`${normCode(code)}|${t}`)), 'AES-GCM', false, ['decrypt'])
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(iv) }, key, b64(box)))
}
/** Server-supplied display strings: one line, bounded. */
const clean = (s, n = 80) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ').slice(0, n)

// ───────────────────────── connections ─────────────────────────

class Conn {
  constructor(port) {
    this.port = port
    // connecting | unpaired | pairing | mismatch | ready | alias | closed
    this.status = 'connecting'
    this.project = ''
    this.id = ''
    this.server = null
    this.error = ''
    this.code = null
    this.t = ''
    this.clientNonce = nonce()
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`)
    this.ws.onopen = () => {
      this.send({ t: 'hello', v: BRIDGE_PROTOCOL, browser: BROWSER, extVersion: EXT_VERSION, caps: CAPS, nonce: this.clientNonce, paired: !!state.token })
      this.pinger = setInterval(() => this.send({ t: 'ping' }), PING_MS)
    }
    this.ws.onmessage = (ev) => void this.onMessage(ev.data).catch(() => this.ws.close())
    this.ws.onclose = () => this.onClose()
    this.ws.onerror = () => {}
  }
  send(obj) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj))
  }
  async onMessage(data) {
    let msg
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return
    switch (msg.t) {
      case 'pong':
        return dialPeers(msg.peers)
      case 'challenge': {
        if (msg.port !== this.port || typeof msg.nonce !== 'string') return this.ws.close() // proofs are port-bound
        this.project = clean(msg.project, 60)
        this.id = clean(msg.id, 16)
        noteServerSeen()
        dialPeers(msg.peers)
        // Same server instance already reachable on another port (it took over the base port): stay idle.
        if ([...conns.values()].some((c) => c !== this && c.id === this.id && c.status !== 'closed' && c.status !== 'alias')) {
          this.status = 'alias'
          return
        }
        this.t = `${this.clientNonce}|${msg.nonce}|${this.port}`
        if (state.token) {
          if (!sameHex(msg.proof, await hmac(state.token, 's|' + this.t))) {
            this.status = 'mismatch' // this server's key differs: user must reset + re-pair
            updateBadge()
            return this.ws.close()
          }
          return this.send({ t: 'auth', proof: await hmac(state.token, 'c|' + this.t) })
        }
        this.status = msg.pairing ? 'pairing' : 'unpaired'
        return updateBadge()
      }
      case 'pairing-open':
        if (this.status === 'unpaired') this.status = 'pairing'
        return updateBadge()
      case 'pair-error':
        this.error = clean(msg.message, 160)
        this.status = 'pairing'
        return updateBadge()
      case 'offer': {
        if (!this.code || !sameHex(msg.proof, await hmac(normCode(this.code), 'ps|' + this.t))) return this.ws.close() // not the server whose code the user typed
        state.token = await openToken(this.code, this.t, msg.iv, msg.box)
        await api.storage.local.set({ token: state.token })
        this.code = null
        this.send({ t: 'auth', proof: await hmac(state.token, 'c|' + this.t) })
        // Servers on this machine share the key — redial the others as paired.
        for (const c of conns.values()) if (c !== this && (c.status === 'unpaired' || c.status === 'pairing')) c.ws.close()
        return
      }
      case 'ready':
        this.status = 'ready'
        this.error = ''
        this.server = msg.server ? { project: clean(msg.server.project, 60), cwd: clean(msg.server.cwd, 120), version: clean(msg.server.version, 16) } : null
        return updateBadge()
      case 'req':
        if (this.status !== 'ready') return
        try {
          const result = await handle(this, msg.method, msg.params || {})
          this.send({ t: 'res', id: msg.id, result: result ?? null })
        } catch (err) {
          this.send({ t: 'res', id: msg.id, error: { message: err && err.message ? err.message : String(err) } })
        }
    }
  }
  async pair(code) {
    this.code = code
    this.error = ''
    this.send({ t: 'pair', proof: await hmac(normCode(code), 'pc|' + this.t) })
  }
  onClose() {
    clearInterval(this.pinger)
    const keep = this.status === 'mismatch'
    if (!keep) this.status = 'closed'
    if (conns.get(this.port) === this && !keep) conns.delete(this.port)
    for (const [tabId, port] of attached) {
      if (port === this.port) {
        attached.delete(tabId)
        if (HAS_CDP) void api.debugger.detach({ tabId }).catch(() => {})
      }
    }
    updateBadge()
  }
  emit(event, params) {
    if (this.status === 'ready') this.send({ t: 'evt', event, params })
  }
}

/**
 * Discovery without noise: Chrome records every refused WebSocket as an extension
 * error, so only the base port is ever probed blind. The server there lists the
 * other live servers (`peers`) and the servers keep the base port occupied while
 * any of them runs. With nothing running, probes back off from 30s to 5min;
 * opening the popup probes immediately.
 */
/** Peers are live servers another server found for us: dial them (no blind probing). */
function dialPeers(peers) {
  for (const p of Array.isArray(peers) ? peers : []) {
    const port = Number(p)
    if (Number.isInteger(port) && port > state.basePort && port < state.basePort + BRIDGE_PORT_SPAN && !conns.has(port)) conns.set(port, new Conn(port))
  }
}

let nextProbe = 0
let backoff = 30_000
function noteServerSeen() {
  backoff = 30_000
}
async function scan(force = false) {
  await load()
  const base = conns.get(state.basePort)
  if (base && base.status !== 'closed' && !(base.status === 'mismatch' && force)) return
  if (!force && Date.now() < nextProbe) return
  if (base) conns.delete(state.basePort)
  const c = new Conn(state.basePort)
  conns.set(state.basePort, c)
  c.ws.addEventListener('close', () => {
    if (c.status === 'closed' && !c.id) {
      // never reached the handshake: nothing listening — back off
      nextProbe = Date.now() + backoff
      backoff = Math.min(backoff * 2, 300_000)
    }
  })
}

function updateBadge() {
  const list = [...conns.values()]
  const waiting = list.some((c) => c.status === 'pairing' || c.status === 'mismatch')
  const ready = list.filter((c) => c.status === 'ready').length
  const action = api.action ?? api.browserAction
  void action.setBadgeText({ text: waiting ? '!' : ready ? String(ready) : '' })
  void action.setBadgeBackgroundColor({ color: waiting ? '#d97706' : '#6d28d9' })
}

// ───────────────────────── request handlers ─────────────────────────

function requireTab(tabId) {
  if (!allowedTab(tabId)) throw new Error(`tab ${tabId} is not shared with the agent — the user must click "Share this tab" in the Visionaire popup, or the agent opens its own tab with a url`)
}
async function requireSite(tabId) {
  const tab = await api.tabs.get(tabId)
  const url = tab.url ?? tabUrls.get(tabId) ?? ''
  if (!siteAllowed(tabId, url)) throw new Error(`tab ${tabId} is on ${originOf(url)}, which the user has not approved for the agent`)
  return tab
}

async function tabInfo(tab) {
  return { tabId: tab.id, url: tab.url ?? '', title: tab.title ?? '', shared: state.shared.includes(tab.id), owned: state.owned.includes(tab.id), active: !!tab.active }
}

let groupId = null
async function addToGroup(tabId) {
  if (!api.tabs.group || !api.tabGroups) return
  try {
    if (groupId !== null) {
      await api.tabs.group({ tabIds: [tabId], groupId })
      return
    }
  } catch {
    groupId = null // group was closed
  }
  try {
    groupId = await api.tabs.group({ tabIds: [tabId] })
    await api.tabGroups.update(groupId, { title: 'Visionaire', color: 'purple' })
  } catch {
    // tab groups unavailable (Firefox < 139, some Chromium forks)
  }
}

function waitForComplete(tabId, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      api.tabs.onUpdated.removeListener(listener)
      resolve()
    }
    const listener = (id, change) => {
      if (id === tabId && change.status === 'complete') done()
    }
    const timer = setTimeout(done, timeoutMs)
    api.tabs.onUpdated.addListener(listener)
  })
}

/** Stylesheet URLs the tab itself references (incl. @import) — the only URLs lite.fetch may read. */
async function sheetHrefs(tabId) {
  const r = await api.scripting.executeScript({ target: { tabId }, func: vzCollect, args: ['sheetHrefs', {}] })
  return new Set((r && r[0] && r[0].result) || [])
}

async function handle(conn, method, p) {
  await load()
  switch (method) {
    case 'tabs.list': {
      const tabs = await api.tabs.query({})
      return Promise.all(tabs.filter((t) => allowedTab(t.id)).map(tabInfo))
    }
    case 'tabs.open': {
      if (!state.allowOpen) throw new Error('the user disabled "Allow the agent to open tabs" in the Visionaire popup')
      const later = await ensureSite(null, p.url, 'open it in a new tab')
      // Chrome: open blank, attach, then navigate through CDP (so load events are observed).
      const tab = await api.tabs.create({ url: HAS_CDP ? 'about:blank' : p.url, active: p.active ?? state.openActive })
      state.owned.push(tab.id)
      if (later === 'grant-after-open') await grant(tab.id, p.url)
      else await saveTabs()
      await addToGroup(tab.id)
      if (!HAS_CDP) await waitForComplete(tab.id)
      return tabInfo(await api.tabs.get(tab.id))
    }
    case 'tabs.activate': {
      requireTab(p.tabId)
      const tab = await api.tabs.update(p.tabId, { active: true })
      await api.windows.update(tab.windowId, { focused: true }).catch(() => {})
      return {}
    }
    case 'tabs.close': {
      if (!state.owned.includes(p.tabId)) throw new Error('the agent may only close tabs it opened')
      await api.tabs.remove(p.tabId)
      return {}
    }
    case 'tabs.navigate': {
      requireTab(p.tabId)
      await ensureSite(p.tabId, p.url, 'navigate the inspected tab there')
      await api.tabs.update(p.tabId, { url: p.url })
      await waitForComplete(p.tabId)
      return tabInfo(await api.tabs.get(p.tabId))
    }
    case 'tabs.reload': {
      requireTab(p.tabId)
      await requireSite(p.tabId)
      await api.tabs.reload(p.tabId, { bypassCache: !!p.bypassCache })
      await waitForComplete(p.tabId)
      return tabInfo(await api.tabs.get(p.tabId))
    }
    case 'tabs.capture': {
      requireTab(p.tabId)
      await requireSite(p.tabId)
      const tab = await api.tabs.update(p.tabId, { active: true })
      await new Promise((r) => setTimeout(r, 150))
      return { dataUrl: await api.tabs.captureVisibleTab(tab.windowId, { format: 'png' }) }
    }
    case 'cdp.attach': {
      if (!HAS_CDP) throw new Error('this browser has no DevTools Protocol for extensions — use lite.* commands')
      requireTab(p.tabId)
      const current = await api.tabs.get(p.tabId)
      if (state.owned.includes(p.tabId) && !siteAllowed(p.tabId, current.url ?? '')) {
        // The agent's own tab wandered off to an unapproved site: blank it before re-attaching.
        await api.tabs.update(p.tabId, { url: 'about:blank' })
        await waitForComplete(p.tabId, 5_000)
      }
      const tab = await requireSite(p.tabId)
      if (attached.has(p.tabId) && attached.get(p.tabId) !== conn.port) {
        throw new Error(`tab ${p.tabId} is already being inspected by another Visionaire server (port ${attached.get(p.tabId)})`)
      }
      if (!attached.has(p.tabId)) {
        try {
          await api.debugger.attach({ tabId: p.tabId }, '1.3')
        } catch (err) {
          if (!/already attached/i.test(String(err && err.message))) throw err
        }
        attached.set(p.tabId, conn.port)
        tabUrls.set(p.tabId, tab.url ?? '')
      }
      const m = navigator.userAgent.match(/(Chrome|Edg|Brave)\/[\d.]+/)
      return { url: tab.url ?? '', title: tab.title ?? '', userAgent: navigator.userAgent, product: m ? m[0] : 'Chrome' }
    }
    case 'cdp.detach': {
      if (attached.get(p.tabId) === conn.port) {
        attached.delete(p.tabId)
        await api.debugger.detach({ tabId: p.tabId }).catch(() => {})
      }
      return {}
    }
    case 'cdp.send': {
      if (attached.get(p.tabId) !== conn.port) throw new Error(`tab ${p.tabId} is not attached — call cdp.attach first`)
      if (!cdpAllowed(p.method)) throw new Error(`${p.method} is blocked by the Visionaire extension's protocol policy`)
      if (!siteAllowed(p.tabId, tabUrls.get(p.tabId) ?? '')) throw new Error('the inspected tab is on a site the user has not approved')
      if (p.method === 'Page.navigate') await ensureSite(p.tabId, String(p.params?.url ?? ''), 'navigate the inspected tab there')
      const target = p.sessionId ? { tabId: p.tabId, sessionId: p.sessionId } : { tabId: p.tabId }
      return api.debugger.sendCommand(target, p.method, p.params || {})
    }
    case 'lite.run': {
      requireTab(p.tabId)
      await requireSite(p.tabId)
      if (p.cmd === 'sheetHrefs') throw new Error('internal command')
      const results = await api.scripting.executeScript({ target: { tabId: p.tabId }, func: vzCollect, args: [p.cmd, p.args || {}] })
      const r = results && results[0]
      if (!r) throw new Error('content script returned nothing (restricted page? about:, addons.mozilla.org and reader view cannot be scripted)')
      if (r.error) throw new Error(String(r.error.message || r.error))
      return r.result
    }
    case 'lite.fetch': {
      requireTab(p.tabId)
      const tab = await requireSite(p.tabId)
      const allowed = await sheetHrefs(p.tabId)
      const tabOrigin = originOf(tab.url ?? '')
      const out = {}
      for (const url of (p.urls || []).slice(0, 20)) {
        // Only stylesheets this page itself loads, over http(s); cookies only for the page's own origin.
        if (!allowed.has(url) || !/^https?:/i.test(url)) {
          out[url] = null
          continue
        }
        try {
          const res = await fetch(url, { credentials: originOf(url) === tabOrigin ? 'include' : 'omit', cache: 'force-cache' })
          out[url] = res.ok ? (await res.text()).slice(0, 2_000_000) : null
        } catch {
          out[url] = null
        }
      }
      return out
    }
    default:
      throw new Error(`unknown bridge method ${String(method).slice(0, 40)}`)
  }
}

// ───────────────────────── browser events ─────────────────────────

if (HAS_CDP) {
  api.debugger.onEvent.addListener((source, method, params) => {
    if (method === 'Page.frameNavigated' && !source.sessionId && params && params.frame && !params.frame.parentId) {
      void onTabNavigated(source.tabId, params.frame.url)
      if (!attached.has(source.tabId)) return // just detached: forward nothing from the new site
    }
    const port = attached.get(source.tabId)
    const c = port !== undefined && conns.get(port)
    if (c) c.emit('cdp.event', { tabId: source.tabId, sessionId: source.sessionId, method, params })
  })
  api.debugger.onDetach.addListener((source, reason) => {
    const port = attached.get(source.tabId)
    attached.delete(source.tabId)
    const c = port !== undefined && conns.get(port)
    if (c) c.emit('cdp.detached', { tabId: source.tabId, reason })
  })
}

api.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url) void onTabNavigated(tabId, change.url)
})

api.tabs.onRemoved.addListener(async (tabId) => {
  await load()
  state.shared = state.shared.filter((t) => t !== tabId)
  state.owned = state.owned.filter((t) => t !== tabId)
  delete state.grants[tabId]
  tabUrls.delete(tabId)
  await saveTabs()
  for (const c of conns.values()) c.emit('tabs.removed', { tabId })
})

// ───────────────────────── popup / approval API ─────────────────────────

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only our own extension pages may drive these.
  if (sender && sender.id && sender.id !== api.runtime.id) return false
  void (async () => {
    await load()
    switch (msg && msg.type) {
      case 'popup.state':
        if (msg.wake) {
          await scan(true) // the user opened the popup: look for servers right now
          await new Promise((r) => setTimeout(r, 400))
        }
        break
      case 'approve.decide': {
        const resolve = approvals.get(msg.id)
        approvals.delete(msg.id)
        if (resolve) resolve(['once', 'always'].includes(msg.decision) ? msg.decision : 'deny')
        return sendResponse({ ok: true })
      }
      case 'popup.pair':
        await conns.get(msg.port)?.pair(msg.code)
        await new Promise((r) => setTimeout(r, 400))
        break
      case 'popup.repair':
        state.token = null
        await api.storage.local.remove('token')
        for (const c of conns.values()) c.ws.close()
        conns.clear()
        await scan(true)
        break
      case 'popup.share': {
        const tab = await api.tabs.get(msg.tabId)
        if (!state.shared.includes(msg.tabId)) state.shared.push(msg.tabId)
        await grant(msg.tabId, tab.url ?? '') // sharing a tab approves the site it is on, for this tab
        break
      }
      case 'popup.unshare': {
        state.shared = state.shared.filter((t) => t !== msg.tabId)
        state.owned = state.owned.filter((t) => t !== msg.tabId)
        delete state.grants[msg.tabId]
        await saveTabs()
        if (HAS_CDP && attached.has(msg.tabId)) {
          attached.delete(msg.tabId)
          await api.debugger.detach({ tabId: msg.tabId }).catch(() => {})
        }
        break
      }
      case 'popup.forgetSite':
        state.sites = state.sites.filter((s) => s !== msg.site)
        await api.storage.local.set({ sites: state.sites })
        break
      case 'popup.settings':
        if (typeof msg.allowOpen === 'boolean') state.allowOpen = msg.allowOpen
        if (typeof msg.openActive === 'boolean') state.openActive = msg.openActive
        if (Number.isInteger(msg.basePort) && msg.basePort > 1023 && msg.basePort < 65520 && msg.basePort !== state.basePort) {
          state.basePort = msg.basePort
          for (const c of conns.values()) c.ws.close()
          conns.clear()
          nextProbe = 0
          await scan(true)
        }
        await api.storage.local.set({ allowOpen: state.allowOpen, openActive: state.openActive, basePort: state.basePort })
        break
      case 'popup.rescan':
        await scan(true)
        await new Promise((r) => setTimeout(r, 400))
        break
    }
    const tabs = await api.tabs.query({})
    sendResponse({
      browser: BROWSER,
      caps: CAPS,
      version: EXT_VERSION,
      paired: !!state.token,
      allowOpen: state.allowOpen,
      openActive: state.openActive,
      basePort: state.basePort,
      sites: state.sites,
      servers: [...conns.values()]
        .filter((c) => !['closed', 'connecting', 'alias'].includes(c.status))
        .map((c) => ({ port: c.port, status: c.status, project: c.project, server: c.server, error: c.error })),
      tabs: tabs.filter((t) => allowedTab(t.id)).map((t) => ({ tabId: t.id, title: t.title, url: t.url, shared: state.shared.includes(t.id), owned: state.owned.includes(t.id), inspecting: attached.has(t.id) })),
    })
  })()
  return true // async sendResponse
})

// ───────────────────────── lifecycle ─────────────────────────

api.alarms.create('vz-scan', { periodInMinutes: 0.5 })
api.alarms.onAlarm.addListener((a) => {
  if (a.name === 'vz-scan') void scan()
})
api.runtime.onStartup?.addListener(() => void scan(true))
api.runtime.onInstalled?.addListener(() => void scan(true))
void scan(true)
// While alive (Firefox persistent page, or a Chrome worker kept up by a socket), check often —
// scan() itself honours the backoff, so this costs nothing when no server runs.
setInterval(() => void scan(), 3_000)
