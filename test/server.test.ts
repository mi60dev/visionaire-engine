/** MCP-level smoke test: the registered surface and the solve wiring, over an in-memory transport. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { createServer } from '../src/server.js'
import { SessionManager } from '../src/session.js'

async function connected(): Promise<Client> {
  const server = createServer(new SessionManager())
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(b)
  return client
}

describe('MCP surface', () => {
  it('registers connect, navigate, set_viewport and solve', async () => {
    const client = await connected()
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['connect', 'navigate', 'set_viewport', 'solve'])
    const connect = tools.find((t) => t.name === 'connect')!
    expect(JSON.stringify(connect.inputSchema)).toContain('extension')
  })

  it('instructions only point at callable tools', async () => {
    const client = await connected()
    const text = client.getInstructions() ?? ''
    expect(text).toContain('solve(')
    expect(text).toMatch(/mode:"extension"/)
    // Engine tool names may appear only as solve({tool}) targets.
    expect(text).toMatch(/call it as\s+solve\(\{intent, tool:"<name>"/)
  })

  it('solve passes its arguments through (v1.0.0 dropped them) and asks for connect first', async () => {
    const client = await connected()
    const res = await client.callTool({ name: 'solve', arguments: { intent: 'button is the wrong color' } })
    const text = (res.content as Array<{ text: string }>)[0]!.text
    expect(text).toMatch(/Not connected to a page\. Call connect first/)
    expect(text).not.toMatch(/toLowerCase/)
  })
})

describe('attach mode', () => {
  it('only accepts loopback DevTools endpoints unless explicitly allowed', async () => {
    const { assertLoopbackDebugUrl } = await import('../src/session.js')
    expect(() => assertLoopbackDebugUrl('http://127.0.0.1:9222')).not.toThrow()
    expect(() => assertLoopbackDebugUrl('http://localhost:9222')).not.toThrow()
    expect(() => assertLoopbackDebugUrl('http://10.0.0.5:9222')).toThrow(/must point at this machine/)
    expect(() => assertLoopbackDebugUrl('http://evil.example:9222')).toThrow(/must point at this machine/)
  })
})
