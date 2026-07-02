#!/usr/bin/env node
/**
 * Bin entry: stdio transport + graceful shutdown. stdout carries the MCP
 * protocol — diagnostics MUST go to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.js'
import { SessionManager } from './session.js'

const session = new SessionManager()
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
  try {
    await server.close()
  } catch {
    // transport may already be gone
  }
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

try {
  await server.connect(new StdioServerTransport())
  console.error('visionaire-engine 0.1.0 ready on stdio')
} catch (err) {
  console.error('visionaire-engine: failed to start:', err)
  await session.disconnect().catch(() => {})
  process.exit(1)
}
