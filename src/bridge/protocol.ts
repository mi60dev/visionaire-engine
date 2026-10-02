/**
 * Wire protocol between the MCP server (WebSocket server on 127.0.0.1) and the
 * Visionaire browser extension (WebSocket client). Mirrored in
 * extension/src/protocol.js — bump BRIDGE_PROTOCOL on any incompatible change.
 *
 * v2 handshake. Every proof is bound to BOTH nonces and the server's port, so a
 * rogue listener cannot relay a real server's proof (it would carry the wrong port):
 *   ext → hello     { v, browser, extVersion, caps, nonce: nC, paired }
 *   srv → challenge { v, nonce: nS, port, project, pairing, proof? = HMAC(token, 's|nC|nS|port') }
 *   paired:   ext → auth { proof: HMAC(token, 'c|nC|nS|port') }            srv → ready { server }
 *   unpaired: the token is NEVER sent in the clear. The agent's connect call opens a
 *     5-minute pairing window and shows the user a one-time code (~59 bits); the user
 *     pastes it into the popup:
 *     ext → pair  { proof: HMAC(code, 'pc|nC|nS|port') }
 *     srv → offer { proof: HMAC(code, 'ps|nC|nS|port'), iv, box: AES-256-GCM(token) }
 *          key = SHA-256(code|nC|nS|port)  → ext stores the token, then sends `auth`.
 * After ready: srv → req {id, method, params}; ext → res {id, result|error};
 * ext → evt {event, params}; ext → ping / srv → pong (keeps the MV3 worker alive).
 */
import { createCipheriv, createHash, createHmac, randomBytes, randomInt } from 'node:crypto'

export const BRIDGE_PROTOCOL = 2
export const DEFAULT_BRIDGE_PORT = 17337
/** Each MCP server instance takes the first free port in [base, base+span). The extension scans the same range. */
export const BRIDGE_PORT_SPAN = 16

export type BrowserKind = 'chrome' | 'firefox'
/** 'cdp' = full DevTools Protocol via chrome.debugger; 'lite' = DOM/CSSOM collector via content scripts. */
export type BridgeCapability = 'cdp' | 'lite'

export interface HelloMessage {
  t: 'hello'
  v: number
  browser: BrowserKind
  extVersion: string
  caps: BridgeCapability[]
  nonce: string
  paired: boolean
}

export interface ServerInfo {
  id: string
  project: string
  cwd: string
  pid: number
  version: string
}

export interface BridgeTab {
  tabId: number
  url: string
  title: string
  /** User clicked "Share this tab" in the popup. */
  shared: boolean
  /** Opened by the agent (tabs.open). */
  owned: boolean
  active: boolean
}

export function hmac(token: string, message: string): string {
  return createHmac('sha256', token).update(message).digest('hex')
}

/** Transcript every proof is bound to. */
export function transcript(clientNonce: string, serverNonce: string, port: number): string {
  return `${clientNonce}|${serverNonce}|${port}`
}

/** Unambiguous alphabet (no 0/O/1/I/L/U): 30 symbols → 12 chars ≈ 59 bits. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'

export function newPairingCode(): string {
  let c = ''
  for (let i = 0; i < 12; i++) c += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`
}

/** Users paste codes with stray spaces/dashes/lowercase. */
export function normalizeCode(code: string): string {
  return String(code).toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** AES-256-GCM box of the token for the extension (WebCrypto layout: ciphertext‖tag). */
export function sealToken(token: string, code: string, t: string): { iv: string; box: string } {
  const key = createHash('sha256').update(`${normalizeCode(code)}|${t}`).digest()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const box = Buffer.concat([cipher.update(token, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return { iv: iv.toString('base64'), box: box.toString('base64') }
}
