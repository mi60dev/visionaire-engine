#!/usr/bin/env node
/**
 * Bin entry: stdio transport + graceful shutdown. stdout carries the MCP
 * protocol — diagnostics MUST go to stderr.
 */
import { createRequire } from 'node:module'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { BridgeServer } from './bridge/server.js'
import { createServer } from './server.js'
import { SessionManager } from './session.js'

const VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version

if (process.argv[2] === 'init-harness') {
  const { initHarness } = await import('./harness-init.js')
  process.exit(await initHarness(process.argv.slice(3)))
}
if (process.argv[2] === 'reset-pairing') {
  const { resetToken, tokenPath } = await import('./bridge/token.js')
  resetToken()
  console.error(`visionaire-engine: new pairing key written to ${tokenPath()} — re-approve the extension in its popup`)
  process.exit(0)
}
if (process.argv[2] === '--help' || process.argv[2] === '-h') {
  console.error('usage: visionaire-engine — start the MCP server on stdio')
  console.error('       visionaire-engine init-harness [--claude|--cursor] [--force] — install hooks')
  console.error('       visionaire-engine reset-pairing — rotate the browser-extension pairing key')
  console.error('env:   VISIONAIRE_BRIDGE=0 disables the extension bridge; VISIONAIRE_BRIDGE_PORT (default 17337)')
  process.exit(0)
}

// Extension bridge: listen from startup so the extension is already paired by the time
// the agent calls connect({mode:"extension"}). Never fatal — the MCP works without it.
let bridge: BridgeServer | undefined
if (process.env['VISIONAIRE_BRIDGE'] !== '0') {
  try {
    bridge = new BridgeServer()
    const port = await bridge.start()
    if (port) console.error(`visionaire-engine: extension bridge on ws://127.0.0.1:${port}`)
    else console.error(`visionaire-engine: extension bridge unavailable — ${bridge.startError}`)
  } catch (err) {
    console.error('visionaire-engine: extension bridge failed to start:', err)
  }
}

const session = new SessionManager(bridge)
const server = createServer(session)

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.error(`visionaire-engine: ${signal} — shutting down`)
  try {
    await session.disconnect()
  } catch (err) {
    console.error('visionaire-engine: browser disconnect failed:', err)
  }
  await bridge?.stop().catch(() => {})
  try {
    await server.close()
  } catch {
    // transport may already be gone
  }
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
// The bridge's listening socket would otherwise keep an orphaned server alive (holding
// its port) after the MCP client goes away — exit when stdin closes.
process.stdin.on('end', () => void shutdown('stdin closed'))
process.stdin.on('close', () => void shutdown('stdin closed'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

try {
  await server.connect(new StdioServerTransport())
  console.error(`visionaire-engine ${VERSION} ready on stdio`)
} catch (err) {
  console.error('visionaire-engine: failed to start:', err)
  await session.disconnect().catch(() => {})
  process.exit(1)
}
