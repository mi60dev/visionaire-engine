/**
 * Extension bridge server: a WebSocket server on 127.0.0.1 that the Visionaire
 * browser extension (Chrome/Firefox) dials into. Lets the MCP drive the user's
 * REAL browser — logged-in sessions, extensions, real profile — without the user
 * starting Chrome with --remote-debugging-port.
 *
 * Security layers (a localhost socket is reachable by every web page the user opens):
 *  1. bind 127.0.0.1 only;
 *  2. Host header must be 127.0.0.1/localhost:<port>  → defeats DNS rebinding;
 *  3. Origin must be this extension → web pages and foreign Chrome extensions are refused;
 *  4. pairing by one-time code (the key never crosses the wire in the clear), then mutual
 *     HMAC bound to both nonces and the port → no relaying, no rogue listener;
 *  5. pre-auth frames ≤4 KB, JSON objects only, ≤16 pending sockets — a hostile frame
 *     closes its socket, never the MCP process.
 * Tab/site/protocol confinement is enforced in the extension (extension/src/background.js).
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  BRIDGE_PORT_SPAN,
  BRIDGE_PROTOCOL,
  DEFAULT_BRIDGE_PORT,
  hmac,
  newPairingCode,
  normalizeCode,
  sealToken,
  transcript,
  type BridgeCapability,
  type BridgeTab,
  type BrowserKind,
  type HelloMessage,
  type ServerInfo,
} from './protocol.js'
import { loadOrCreateToken } from './token.js'

const VERSION: string = (createRequire(import.meta.url)('../../package.json') as { version: string }).version

/** Unauthenticated sockets may wait this long (the user may be pasting a pairing code). */
const HANDSHAKE_TIMEOUT_MS = 6 * 60_000
/** A pairing window (opened by the agent's connect call) lasts this long… */
const PAIRING_WINDOW_MS = 5 * 60_000
/** …and closes after this many wrong codes. */
const PAIRING_MAX_ATTEMPTS = 5
/** Pre-auth frames are tiny; anything bigger is hostile. */
const PREAUTH_MAX_BYTES = 4096
/** Cap on simultaneously unauthenticated sockets. */
const MAX_PENDING = 16
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/** Stable ID of the unpacked Chrome build (manifest "key" in scripts/build-extension.ts). */
export const CHROME_EXTENSION_ID = 'dlmobdbalnhldnkkemdljkegfgjbndei'

/**
 * Chromium origins are pinned to known extension IDs (plus VISIONAIRE_BRIDGE_EXTENSION_IDS,
 * comma-separated, for store builds). Firefox assigns a random moz-extension UUID per
 * install, so it cannot be pinned — the HMAC pairing is what authenticates it.
 */
export function isExtensionOrigin(origin: string | undefined): boolean {
  if (typeof origin !== 'string') return false
  const chrome = /^chrome-extension:\/\/([a-p]{32})\/?$/.exec(origin)
  if (chrome) {
    const extra = (process.env['VISIONAIRE_BRIDGE_EXTENSION_IDS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    return chrome[1] === CHROME_EXTENSION_ID || extra.includes(chrome[1]!)
  }
  return /^moz-extension:\/\/[0-9a-f-]{36}\/?$/i.test(origin)
}

export function isLoopbackHost(host: string | undefined, port: number): boolean {
  if (!host) return false
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`
}

function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
  method: string
}

/** One authenticated extension connection (one browser profile). */
export class BridgeClient extends EventEmitter {
  readonly id = randomUUID().slice(0, 8)
  readonly connectedAt = Date.now()
  private nextId = 1
  private pending = new Map<number, Pending>()
  closed = false

  constructor(
    private ws: WebSocket,
    readonly browser: BrowserKind,
    readonly caps: BridgeCapability[],
    readonly extVersion: string,
  ) {
    super()
    this.setMaxListeners(50)
  }

  get label(): string {
    return `${this.browser} extension v${this.extVersion} [${this.caps.join('+')}]`
  }

  request<T = unknown>(method: string, params: unknown = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`extension bridge closed (${this.label})`))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`extension did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method })
      this.ws.send(JSON.stringify({ t: 'req', id, method, params }))
    })
  }

  /** @internal */
  handle(msg: Record<string, unknown>): void {
    if (msg['t'] === 'res') {
      if (typeof msg['id'] !== 'number') return
      const id = msg['id'] as number
      const p = this.pending.get(id)
      if (!p) return
      this.pending.delete(id)
      clearTimeout(p.timer)
      const err = msg['error'] as { message?: string } | undefined
      if (err) p.reject(new Error(err.message ?? `${p.method} failed in the extension`))
      else p.resolve(msg['result'])
    } else if (msg['t'] === 'evt') {
      this.emit('event', msg['event'], msg['params'])
      this.emit(`event:${String(msg['event'])}`, msg['params'])
    } else if (msg['t'] === 'ping') {
      this.ws.send('{"t":"pong"}')
    }
  }

  /** @internal */
  markClosed(reason: string): void {
    if (this.closed) return
    this.closed = true
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error(`extension disconnected (${reason}) during ${p.method}`))
    }
    this.pending.clear()
    this.emit('close', reason)
  }

  close(): void {
    this.ws.close(1000, 'server closing')
  }

  listTabs(): Promise<BridgeTab[]> {
    return this.request<BridgeTab[]>('tabs.list')
  }
}

export interface BridgeServerOptions {
  port?: number
  span?: number
  token?: string
  project?: string
}

export class BridgeServer extends EventEmitter {
  /** Every port this server listens on: its own, plus the base port once it takes it over. */
  private sockets: Array<{ port: number; http: http.Server; wss: WebSocketServer }> = []
  private takeoverTimer?: NodeJS.Timeout
  private peerCache?: { at: number; ports: number[] }
  private clientsById = new Map<string, BridgeClient>()
  readonly info: ServerInfo
  private token: string
  port = 0
  startError?: string
  /** Open pairing window, if any. */
  private pairing?: { code: string; expires: number; attempts: number }
  private pending = new Set<WebSocket>()

  constructor(private opts: BridgeServerOptions = {}) {
    super()
    this.token = opts.token ?? loadOrCreateToken()
    this.info = {
      id: randomUUID().slice(0, 8),
      project: opts.project ?? path.basename(process.cwd()),
      cwd: process.cwd(),
      pid: process.pid,
      version: VERSION,
    }
  }

  get listening(): boolean {
    return this.port > 0
  }

  clients(): BridgeClient[] {
    return [...this.clientsById.values()].filter((c) => !c.closed)
  }

  private get base(): number {
    return this.opts.port ?? (Number(process.env['VISIONAIRE_BRIDGE_PORT']) || DEFAULT_BRIDGE_PORT)
  }
  private get span(): number {
    return this.opts.span ?? BRIDGE_PORT_SPAN
  }

  /** Bind the first free port in [base, base+span). Never throws: failures are recorded in startError. */
  async start(): Promise<number> {
    const { base, span } = this
    for (let port = base; port < base + span; port++) {
      try {
        await this.listenOn(port)
        this.port = port
        this.startError = undefined
        if (port !== base) this.watchBasePort()
        return port
      } catch (err) {
        this.startError = err instanceof Error ? err.message : String(err)
      }
    }
    this.startError = `no free port in ${base}-${base + span - 1} (${this.startError ?? 'unknown error'})`
    return 0
  }

  /**
   * The extension only ever probes the base port (every refused probe is logged as an
   * extension error in Chrome), and learns the other servers from the `peers` list the
   * base server sends. So the base port must stay occupied while any server runs: when
   * its owner exits, the next server takes it over as a second listener.
   */
  private watchBasePort(): void {
    this.takeoverTimer = setInterval(() => {
      if (this.sockets.some((l) => l.port === this.base)) return
      this.listenOn(this.base).catch(() => {
        // still owned by another server
      })
    }, 5_000)
    this.takeoverTimer.unref()
  }

  /** Other live Visionaire bridges in the range (probed from Node, which logs nothing in the browser). */
  async peers(): Promise<number[]> {
    if (this.peerCache && Date.now() - this.peerCache.at < 3_000) return this.peerCache.ports
    const mine = new Set(this.sockets.map((l) => l.port))
    const candidates: number[] = []
    for (let p = this.base; p < this.base + this.span; p++) if (!mine.has(p)) candidates.push(p)
    const live = await Promise.all(
      candidates.map(
        (p) =>
          new Promise<number | undefined>((resolve) => {
            const req = http.get({ host: '127.0.0.1', port: p, path: '/', timeout: 300 }, (res) => {
              let body = ''
              res.on('data', (c: Buffer) => (body += c.toString().slice(0, 64)))
              res.on('end', () => resolve(body.startsWith('visionaire bridge') ? p : undefined))
            })
            req.on('timeout', () => req.destroy())
            req.on('error', () => resolve(undefined))
          }),
      ),
    )
    const ports = live.filter((p): p is number => p !== undefined)
    this.peerCache = { at: Date.now(), ports }
    return ports
  }

  private listenOn(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((_req, res) => {
        // Plain GET is a liveness probe for peer discovery only — no data, no CORS.
        res.writeHead(426, { 'content-type': 'text/plain' })
        res.end('visionaire bridge: WebSocket only\n')
      })
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject)
        // Created only once the port is ours: a WebSocketServer re-emits its http server's
        // 'error' — an EADDRINUSE on a taken port would otherwise crash the whole MCP process.
        const wss = new WebSocketServer({
          server,
          maxPayload: 64 * 1024 * 1024, // screenshots + DOMSnapshot payloads
          verifyClient: (infoArg: { origin: string; req: http.IncomingMessage }) => {
            const ok = isExtensionOrigin(infoArg.origin) && isLoopbackHost(infoArg.req.headers.host, port)
            if (!ok) {
              console.error(`[visionaire] bridge: refused connection (origin ${String(infoArg.origin).slice(0, 80)}, host ${String(infoArg.req.headers.host).slice(0, 60)})`)
            }
            return ok
          },
        })
        wss.on('connection', (ws) => this.onConnection(ws, port))
        wss.on('error', (err) => console.error('[visionaire] bridge error:', err.message))
        server.on('error', (err) => console.error('[visionaire] bridge http error:', err.message))
        this.sockets.push({ port, http: server, wss })
        resolve()
      })
    })
  }

  /**
   * Open (or return the still-open) pairing window and its one-time code. Called by
   * connect({mode:"extension"}) when no paired extension is connected; the agent shows
   * the code to the user, who pastes it into the extension popup.
   */
  openPairing(): { code: string; expiresInSec: number } {
    const now = Date.now()
    if (!this.pairing || this.pairing.expires < now || this.pairing.attempts >= PAIRING_MAX_ATTEMPTS) {
      this.pairing = { code: newPairingCode(), expires: now + PAIRING_WINDOW_MS, attempts: 0 }
    }
    for (const ws of this.pending) ws.send('{"t":"pairing-open"}')
    return { code: this.pairing.code, expiresInSec: Math.round((this.pairing.expires - now) / 1000) }
  }

  private pairingOpen(): boolean {
    return !!this.pairing && this.pairing.expires > Date.now() && this.pairing.attempts < PAIRING_MAX_ATTEMPTS
  }

  /** Number of extensions connected but waiting to be paired (for connect's error text). */
  get unpairedWaiting(): number {
    return this.pending.size
  }

  private onConnection(ws: WebSocket, port: number): void {
    if (this.pending.size >= MAX_PENDING) {
      ws.close(4429, 'too many pending connections')
      return
    }
    this.pending.add(ws)
    let stage: 'hello' | 'auth' | 'ready' = 'hello'
    let hello: HelloMessage | undefined
    let t = ''
    const serverNonce = randomBytes(16).toString('hex')
    let client: BridgeClient | undefined
    const handshakeTimer = setTimeout(() => {
      if (stage !== 'ready') ws.close(4408, 'handshake timed out')
    }, HANDSHAKE_TIMEOUT_MS)

    const onMessage = async (data: unknown, size: number): Promise<void> => {
      if (stage !== 'ready' && size > PREAUTH_MAX_BYTES) {
        ws.close(4413, 'frame too large before authentication')
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(String(data))
      } catch {
        ws.close(4400, 'bad json')
        return
      }
      // Only plain objects are frames — `null`, numbers and strings must never reach property access.
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        ws.close(4400, 'bad frame')
        return
      }
      const msg = parsed as Record<string, unknown>
      if (msg['t'] === 'ping') {
        // Keeps the MV3 worker alive, and tells the extension about servers started since.
        ws.send(JSON.stringify({ t: 'pong', peers: await this.peers() }))
        return
      }
      if (stage === 'ready') {
        client?.handle(msg)
        return
      }
      if (stage === 'hello' && msg['t'] === 'hello') {
        hello = msg as unknown as HelloMessage
        if (hello.v !== BRIDGE_PROTOCOL) {
          ws.send(JSON.stringify({ t: 'error', message: `protocol mismatch: server v${BRIDGE_PROTOCOL}, extension v${String(hello.v).slice(0, 8)} — update the older side` }))
          ws.close(4426, 'protocol mismatch')
          return
        }
        if (typeof hello.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(hello.nonce)) {
          ws.close(4400, 'bad nonce')
          return
        }
        stage = 'auth'
        t = transcript(hello.nonce, serverNonce, port)
        if (process.env['VISIONAIRE_BRIDGE_DEBUG']) {
          console.error(`[visionaire] bridge: hello from ${String(hello.browser).slice(0, 10)} (paired: ${hello.paired === true})`)
        }
        const peers = await this.peers()
        if (ws.readyState !== ws.OPEN) return
        ws.send(
          JSON.stringify({
            t: 'challenge',
            v: BRIDGE_PROTOCOL,
            nonce: serverNonce,
            port,
            // Instance id lets the extension spot this server again on another port (base takeover).
            id: this.info.id,
            // Other live servers: the extension dials these instead of probing (refused probes are logged).
            peers,
            // Pre-auth: only a display name. cwd/pid/version are sent after authentication.
            project: this.info.project.slice(0, 60),
            pairing: this.pairingOpen(),
            ...(hello.paired === true ? { proof: hmac(this.token, 's|' + t) } : {}),
          }),
        )
        return
      }
      if (stage === 'auth' && msg['t'] === 'pair' && hello) {
        if (!this.pairingOpen()) {
          ws.send('{"t":"pair-error","message":"no pairing window is open — ask your agent to run connect with mode \\"extension\\" for a new code"}')
          return
        }
        const p = this.pairing!
        const code = normalizeCode(p.code)
        if (!safeEqualHex(String(msg['proof']), hmac(code, 'pc|' + t))) {
          p.attempts++
          ws.send(JSON.stringify({ t: 'pair-error', message: `wrong pairing code (${PAIRING_MAX_ATTEMPTS - p.attempts} attempts left)` }))
          return
        }
        this.pairing = undefined // one-time
        ws.send(JSON.stringify({ t: 'offer', proof: hmac(code, 'ps|' + t), ...sealToken(this.token, code, t) }))
        return
      }
      if (stage === 'auth' && msg['t'] === 'auth' && hello) {
        if (!safeEqualHex(String(msg['proof']), hmac(this.token, 'c|' + t))) {
          console.error('[visionaire] bridge: an extension failed the pairing proof — it must be re-paired')
          ws.close(4401, 'pairing key mismatch')
          return
        }
        stage = 'ready'
        this.pending.delete(ws)
        clearTimeout(handshakeTimer)
        const browser = hello.browser === 'firefox' ? 'firefox' : 'chrome'
        const caps = (Array.isArray(hello.caps) ? hello.caps : []).filter((c): c is BridgeCapability => c === 'cdp' || c === 'lite')
        client = new BridgeClient(ws, browser, caps, String(hello.extVersion ?? '?').slice(0, 16))
        this.clientsById.set(client.id, client)
        ws.send(JSON.stringify({ t: 'ready', server: this.info }))
        console.error(`[visionaire] bridge: ${client.label} connected on port ${port}`)
        this.emit('client', client)
        return
      }
      ws.close(4400, `unexpected ${String(msg['t']).slice(0, 20)} during ${stage}`)
    }

    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      const size = Array.isArray(data) ? data.reduce((n, b) => n + b.length, 0) : (data as Buffer).byteLength
      // Never let one hostile frame take the MCP process down.
      onMessage(data, size).catch((err: unknown) => {
        console.error('[visionaire] bridge: dropped a connection after a bad frame:', err instanceof Error ? err.message : err)
        ws.close(4400, 'bad frame')
      })
    })

    ws.on('close', (_code, reason) => {
      clearTimeout(handshakeTimer)
      this.pending.delete(ws)
      if (client) {
        this.clientsById.delete(client.id)
        client.markClosed(String(reason) || 'socket closed')
        console.error(`[visionaire] bridge: ${client.label} disconnected`)
        this.emit('client-closed', client)
      }
    })
    ws.on('error', () => {
      // 'close' follows; nothing else to do.
    })
  }

  /** Resolve with the best connected client, waiting up to timeoutMs for one to dial in. */
  async waitForClient(timeoutMs: number, prefer?: BrowserKind): Promise<BridgeClient | undefined> {
    const pick = (): BridgeClient | undefined => {
      const all = this.clients()
      if (prefer) {
        const match = all.filter((c) => c.browser === prefer)
        if (match.length) return match[match.length - 1]
      }
      // Prefer full-CDP clients, newest first.
      return [...all].sort((a, b) => Number(b.caps.includes('cdp')) - Number(a.caps.includes('cdp')) || b.connectedAt - a.connectedAt)[0]
    }
    const now = pick()
    if (now || timeoutMs <= 0) return now
    return new Promise((resolve) => {
      const onClient = (): void => {
        const c = pick()
        if (!c) return
        clearTimeout(timer)
        this.off('client', onClient)
        resolve(c)
      }
      const timer = setTimeout(() => {
        this.off('client', onClient)
        resolve(pick())
      }, timeoutMs)
      this.on('client', onClient)
    })
  }

  async stop(): Promise<void> {
    clearInterval(this.takeoverTimer)
    for (const c of this.clients()) c.close()
    for (const ws of this.pending) ws.close(1001, 'server closing')
    for (const l of this.sockets) {
      await new Promise<void>((resolve) => l.wss.close(() => resolve()))
      await new Promise<void>((resolve) => l.http.close(() => resolve()))
    }
    this.sockets = []
    this.port = 0
  }
}
