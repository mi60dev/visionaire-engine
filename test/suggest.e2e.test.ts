/**
 * A guessed selector that doesn't exist in the live DOM should return a helpful
 * near-miss suggestion (closest real ids/classes) + a grounding nudge — not a dead end.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SessionManager, findChromeExecutable } from '../src/session.js'
import { inspectElementTool } from '../src/tools/inspect-element.js'
import { findElementsTool } from '../src/tools/find-elements.js'
import type { ToolContext } from '../src/types.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureUrl = pathToFileURL(path.join(here, 'fixtures', 'cascade.html')).href
const hasChrome = !!findChromeExecutable()

describe.skipIf(!hasChrome)('selector near-miss suggestions', () => {
  let session: SessionManager
  let ctx: ToolContext

  beforeAll(async () => {
    session = new SessionManager()
    ctx = await session.connect({ mode: 'launch', headless: true, url: fixtureUrl })
  }, 60_000)

  afterAll(async () => {
    await session?.disconnect()
  })

  it('inspect_element on a nonexistent class suggests the closest real one', async () => {
    // The fixture has `.hero-cta`; ask for a near-miss typo.
    await expect(inspectElementTool.handler(ctx, { selector: '.hero-ctaa' })).rejects.toThrow(
      /No element matches selector.*hero-cta/s,
    )
  })

  it('the suggestion points at grounding tools', async () => {
    let msg = ''
    try {
      await inspectElementTool.handler(ctx, { selector: '#totally-made-up-id' })
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e)
    }
    expect(msg).toMatch(/page_snapshot|project source/i)
  })

  it('find_elements with no selector match nudges toward a snapshot', async () => {
    const res = await findElementsTool.handler(ctx, { selector: '.does-not-exist-anywhere' })
    expect(res.text).toMatch(/no elements matched/i)
    expect(res.text).toMatch(/page_snapshot|Did you mean|project source/i)
  })

  it('a malformed selector is reported as invalid, not as no-match', async () => {
    await expect(inspectElementTool.handler(ctx, { selector: '###' })).rejects.toThrow(/Invalid CSS selector/i)
  })
})
