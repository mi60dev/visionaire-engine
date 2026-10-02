/**
 * Bridge handshake security, driven by a raw WebSocket client posing as the
 * extension (no browser): no token on the wire, port-bound proofs (relay
 * defence), one-time pairing codes with an attempt limit, and hostile frames.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { webcrypto } from 'node:crypto'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hmac, normalizeCode, transcript } from '../src/bridge/protocol.js'
import { BridgeServer, CHROME_EXTENSION_ID } from '../src/bridge/server.js'

const ORIGIN = `chrome-extension://${CHROME_EXTENSION_ID}`
const nonce = (): string => Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('hex')

/** A scripted fake extension: send frames, await the next message. */
async function dial(port: number, origin = ORIGIN): Promise<{ ws: WebSocket; next: () => Promise<Record<string, unknown>>; closed: Promise<number> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin })
  const queue: Array<Record<string, unknown>> = []
  const waiters: Array<(m: Record<string, unknown>) => void> = []
  ws.on('message', (d) => {
    const m = JSON.parse(String(d)) as Record<string, unknown>
    const w = waiters.shift()
    if (w) w(m)
    else queue.push(m)
  })
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  const next = (): Promise<Record<string, unknown>> =>
    queue.length ? Promise.resolve(queue.shift()!) : new Promise((r) => waiters.push(r))
  return { ws, next, closed }
}
const hello = (n: string, paired: boolean) => JSON.stringify({ t: 'hello', v: 2, browser: 'chrome', extVersion: 't', caps: ['cdp'], nonce: n, paired })

describe('bridge handshake security', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vz-proto-'))
  let bridge: BridgeServer
  let token = ''

  beforeAll(async () => {
    process.env['VISIONAIRE_HOME'] = home
    bridge = new BridgeServer({ project: 'proto', port: 17437, span: 8 })
    expect(await bridge.start()).toBeGreaterThan(0)
    token = fs.readFileSync(path.join(home, 'bridge-token'), 'utf8').trim()
  })
  afterAll(async () => {
    await bridge.stop()
    delete process.env['VISIONAIRE_HOME']
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('never puts the token on the wire for an unpaired client', async () => {
    const { ws, next } = await dial(bridge.port)
    ws.send(hello(nonce(), false))
    const ch = await next()
    expect(ch['t']).toBe('challenge')
    expect(JSON.stringify(ch)).not.toContain(token)
    expect(ch).not.toHaveProperty('offer')
    expect(ch).not.toHaveProperty('server') // cwd/pid only after auth
    ws.close()
  })

  it('binds the server proof to the port, so a relay on another port fails', async () => {
    const nC = nonce()
    const { ws, next } = await dial(bridge.port)
    ws.send(hello(nC, true))
    const ch = await next()
    const t = transcript(nC, String(ch['nonce']), bridge.port)
    expect(ch['proof']).toBe(hmac(token, 's|' + t))
    // What a rogue relay on another port would have to present:
    expect(ch['proof']).not.toBe(hmac(token, 's|' + transcript(nC, String(ch['nonce']), bridge.port + 1)))
    ws.send(JSON.stringify({ t: 'auth', proof: hmac(token, 'c|' + t) }))
    const ready = await next()
    expect(ready['t']).toBe('ready')
    expect((ready['server'] as { cwd: string }).cwd).toBe(process.cwd())
    ws.close()
  })

  it('pairs only with the one-time code, delivers the token sealed, and burns the code', async () => {
    const { code } = bridge.openPairing()
    const nC = nonce()
    const { ws, next } = await dial(bridge.port)
    ws.send(hello(nC, false))
    const ch = await next()
    expect(ch['pairing']).toBe(true)
    const t = transcript(nC, String(ch['nonce']), bridge.port)
    ws.send(JSON.stringify({ t: 'pair', proof: hmac(normalizeCode(code), 'pc|' + t) }))
    const offer = await next()
    expect(offer['t']).toBe('offer')
    expect(offer['proof']).toBe(hmac(normalizeCode(code), 'ps|' + t))
    expect(JSON.stringify(offer)).not.toContain(token)
    const key = await webcrypto.subtle.importKey('raw', await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(`${normalizeCode(code)}|${t}`)), 'AES-GCM', false, ['decrypt'])
    const plain = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(String(offer['iv']), 'base64') }, key, Buffer.from(String(offer['box']), 'base64'))
    expect(new TextDecoder().decode(plain)).toBe(token)
    ws.close()
    // One-time: a second client with the same code gets nothing.
    const nC2 = nonce()
    const second = await dial(bridge.port)
    second.ws.send(hello(nC2, false))
    const ch2 = await second.next()
    expect(ch2['pairing']).toBe(false)
    second.ws.send(JSON.stringify({ t: 'pair', proof: hmac(normalizeCode(code), 'pc|' + transcript(nC2, String(ch2['nonce']), bridge.port)) }))
    expect((await second.next())['t']).toBe('pair-error')
    second.ws.close()
  })

  it('closes the pairing window after 5 wrong codes', async () => {
    bridge.openPairing()
    const nC = nonce()
    const { ws, next } = await dial(bridge.port)
    ws.send(hello(nC, false))
    const ch = await next()
    const t = transcript(nC, String(ch['nonce']), bridge.port)
    for (let i = 0; i < 5; i++) {
      ws.send(JSON.stringify({ t: 'pair', proof: hmac('WRONGCODE' + i, 'pc|' + t) }))
      expect(String((await next())['message'])).toMatch(/wrong pairing code/)
    }
    ws.send(JSON.stringify({ t: 'pair', proof: 'x' }))
    expect(String((await next())['message'])).toMatch(/no pairing window/)
    ws.close()
  })

  it('survives hostile frames instead of crashing the MCP process', async () => {
    for (const frame of ['null', '1', '"x"', '[]', '{"t":"hello","v":2,"nonce":"zz"}', 'x'.repeat(5000)]) {
      const { ws, closed } = await dial(bridge.port)
      ws.send(frame)
      expect(await closed).toBeGreaterThanOrEqual(4000)
    }
    // still serving
    const { ws, next } = await dial(bridge.port)
    ws.send(hello(nonce(), false))
    expect((await next())['t']).toBe('challenge')
    ws.close()
  })

  it('refuses web pages and foreign extensions at the upgrade', async () => {
    for (const origin of ['https://evil.example', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop']) {
      await expect(dial(bridge.port, origin)).rejects.toThrow(/403|Unexpected server response/)
    }
  })
})

describe('discovery without blind probing', () => {
  it('lists live peers in the challenge and pong, and keeps the base port occupied', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vz-disc-'))
    process.env['VISIONAIRE_HOME'] = home
    const a = new BridgeServer({ project: 'a', port: 17450, span: 4 })
    const b = new BridgeServer({ project: 'b', port: 17450, span: 4 })
    try {
      expect(await a.start()).toBe(17450)
      expect(await b.start()).toBe(17451)
      const { ws, next } = await dial(17450)
      ws.send(hello(nonce(), false))
      expect((await next())['peers']).toEqual([17451])
      ws.send('{"t":"ping"}')
      expect(await next()).toEqual({ t: 'pong', peers: [17451] })
      ws.close()
      // The base server exits → the next one takes the base port over within ~5s.
      await a.stop()
      await new Promise((r) => setTimeout(r, 6_000))
      const again = await dial(17450)
      again.ws.send(hello(nonce(), false))
      const ch = await again.next()
      expect(ch['project']).toBe('b')
      expect(ch['port']).toBe(17450) // proofs bind to the port actually dialed
      again.ws.close()
    } finally {
      await a.stop()
      await b.stop()
      delete process.env['VISIONAIRE_HOME']
      fs.rmSync(home, { recursive: true, force: true })
    }
  }, 20_000)
})
