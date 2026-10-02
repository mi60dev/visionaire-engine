/**
 * Puppeteer ConnectionTransport that tunnels CDP through the browser extension's
 * chrome.debugger attachment to ONE tab. chrome.debugger exposes a single tab
 * session, not a browser endpoint, so — like puppeteer's in-extension
 * ExtensionTransport — the browser-level Target.* surface puppeteer needs is
 * emulated here, plus one thing ExtensionTransport lacks: page.createCDPSession()
 * (Target.attachToTarget) gets a *virtual* session multiplexed onto the same
 * debugger attachment. That is what the engine's tools use.
 *
 * Multiplexing caveat: all virtual sessions share one real CDP session, so a
 * `X.disable` from one would silently break the others — domain disables that
 * puppeteer relies on are acknowledged without forwarding.
 */
import type { ConnectionTransport } from 'puppeteer-core'
import type { BridgeClient } from './server.js'

const TAB_SESSION = 'tabTargetSessionId'
const PAGE_SESSION = 'pageTargetSessionId'
const TAB_TARGET = 'tabTargetId'

/** Shared-domain disables that would break puppeteer's own page session. */
const SWALLOWED = new Set(['Runtime.disable', 'Page.disable', 'Network.disable', 'Log.disable', 'Performance.disable'])

interface CdpMessage {
  id?: number
  sessionId?: string
  method?: string
  params?: Record<string, unknown>
}

export interface AttachInfo {
  url: string
  title: string
  userAgent: string
  product: string
}

export class ExtensionCdpTransport implements ConnectionTransport {
  onmessage?: (message: string) => void
  onclose?: () => void
  private virtualSessions = new Set<string>()
  private nextVirtual = 1
  private closed = false
  /** Why the debugger session ended, when the browser told us (e.g. 'canceled_by_user'). */
  detachReason?: string
  private readonly pageTargetId: string
  private readonly onEvent: (params: { tabId: number; sessionId?: string; method: string; params: unknown }) => void
  private readonly onDetached: (params: { tabId: number; reason?: string }) => void
  private readonly onClientClose: () => void

  constructor(
    private client: BridgeClient,
    readonly tabId: number,
    private info: AttachInfo,
  ) {
    this.pageTargetId = `tab-${tabId}`
    this.onEvent = (p) => {
      if (p.tabId !== this.tabId) return
      if (p.sessionId) {
        this.dispatch({ sessionId: p.sessionId, method: p.method, params: p.params as Record<string, unknown> })
        return
      }
      if (p.method === 'Page.frameNavigated') {
        const frame = (p.params as { frame?: { parentId?: string; url?: string } }).frame
        if (frame && !frame.parentId && frame.url) this.info.url = frame.url
      }
      this.dispatch({ sessionId: PAGE_SESSION, method: p.method, params: p.params as Record<string, unknown> })
      // Fan out to engine sessions — but never Target.* (puppeteer would double-register children).
      if (!p.method.startsWith('Target.')) {
        for (const s of this.virtualSessions) this.dispatch({ sessionId: s, method: p.method, params: p.params as Record<string, unknown> })
      }
    }
    this.onDetached = (p) => {
      if (p.tabId !== this.tabId) return
      this.detachReason = p.reason ?? 'detached'
      this.shutdown()
    }
    this.onClientClose = () => {
      this.detachReason = 'extension disconnected'
      this.shutdown()
    }
    client.on('event:cdp.event', this.onEvent)
    client.on('event:cdp.detached', this.onDetached)
    client.on('close', this.onClientClose)
  }

  private targetInfo(type: 'tab' | 'page', attached = true): Record<string, unknown> {
    return {
      targetId: type === 'tab' ? TAB_TARGET : this.pageTargetId,
      type,
      title: this.info.title,
      url: this.info.url,
      attached,
      canAccessOpener: false,
      browserContextId: 'default',
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    // New task, like puppeteer's own transports — callers may not expect sync re-entry.
    setTimeout(() => {
      if (!this.closed) this.onmessage?.(JSON.stringify(message))
    }, 0)
  }

  private reply(msg: CdpMessage, result: unknown): void {
    this.dispatch({ id: msg.id, sessionId: msg.sessionId, result })
  }

  private replyError(msg: CdpMessage, message: string): void {
    this.dispatch({ id: msg.id, sessionId: msg.sessionId, error: { code: -32000, message } })
  }

  send(message: string): void {
    const msg = JSON.parse(message) as CdpMessage
    const method = msg.method ?? ''

    // ── browser-level / tab-level emulation ──
    if (!msg.sessionId || msg.sessionId === TAB_SESSION) {
      switch (method) {
        case 'Browser.getVersion':
          return this.reply(msg, {
            protocolVersion: '1.3',
            product: this.info.product,
            revision: 'extension-bridge',
            userAgent: this.info.userAgent,
            jsVersion: 'unknown',
          })
        case 'Target.getBrowserContexts':
          return this.reply(msg, { browserContextIds: [] })
        case 'Target.setDiscoverTargets':
          this.dispatch({ method: 'Target.targetCreated', params: { targetInfo: this.targetInfo('tab', false) } })
          this.dispatch({ method: 'Target.targetCreated', params: { targetInfo: this.targetInfo('page', false) } })
          return this.reply(msg, {})
        case 'Target.setAutoAttach':
          if (msg.sessionId === TAB_SESSION) {
            this.dispatch({
              method: 'Target.attachedToTarget',
              sessionId: TAB_SESSION,
              params: { targetInfo: this.targetInfo('page'), sessionId: PAGE_SESSION, waitingForDebugger: false },
            })
          } else {
            this.dispatch({
              method: 'Target.attachedToTarget',
              params: { targetInfo: this.targetInfo('tab'), sessionId: TAB_SESSION, waitingForDebugger: false },
            })
          }
          return this.reply(msg, {})
        case 'Target.getTargets':
          return this.reply(msg, { targetInfos: [this.targetInfo('tab'), this.targetInfo('page')] })
        case 'Target.getTargetInfo':
          return this.reply(msg, { targetInfo: this.targetInfo('page') })
        case 'Target.attachToTarget': {
          const sessionId = `vz-${this.tabId}-${this.nextVirtual++}`
          this.virtualSessions.add(sessionId)
          // puppeteer registers the CDPSession on this event, before the response lands.
          this.dispatch({
            method: 'Target.attachedToTarget',
            params: { targetInfo: this.targetInfo('page'), sessionId, waitingForDebugger: false },
          })
          return this.reply(msg, { sessionId })
        }
        case 'Target.detachFromTarget': {
          const sid = String(msg.params?.['sessionId'] ?? '')
          if (this.virtualSessions.delete(sid)) {
            this.dispatch({ method: 'Target.detachedFromTarget', params: { sessionId: sid, targetId: this.pageTargetId } })
          }
          return this.reply(msg, {})
        }
        case 'Target.activateTarget':
          void this.client.request('tabs.activate', { tabId: this.tabId }).catch(() => {})
          return this.reply(msg, {})
        case 'Runtime.runIfWaitingForDebugger':
          return this.reply(msg, {})
        default:
          return this.replyError(msg, `${method} is not available through the Visionaire extension bridge (single-tab chrome.debugger session)`)
      }
    }

    if (SWALLOWED.has(method)) return this.reply(msg, {})

    // ── page-level: forward to chrome.debugger ──
    const isOurs = msg.sessionId === PAGE_SESSION || this.virtualSessions.has(msg.sessionId)
    const childSession = isOurs ? undefined : msg.sessionId
    this.client
      .request('cdp.send', { tabId: this.tabId, sessionId: childSession, method, params: msg.params ?? {} }, 60_000)
      .then((result) => this.reply(msg, result ?? {}))
      .catch((err: unknown) => this.replyError(msg, err instanceof Error ? err.message : String(err)))
  }

  private shutdown(): void {
    if (this.closed) return
    this.closed = true
    this.client.off('event:cdp.event', this.onEvent)
    this.client.off('event:cdp.detached', this.onDetached)
    this.client.off('close', this.onClientClose)
    this.onclose?.()
  }

  close(): void {
    if (this.closed) return
    void this.client.request('cdp.detach', { tabId: this.tabId }).catch(() => {})
    this.shutdown()
  }
}
