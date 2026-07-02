/**
 * E2E hardening tests against a deliberately hostile fixture (real headless Chrome):
 * (1) a page-load dialog must not dead-lock any tool; (2) injection-shaped text in
 * element content/attributes must reach output only as inert single-line fragments.
 * Reproduces the three findings from the 2026-07-02 field report.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SessionManager, findChromeExecutable } from '../src/session.js'
import { pageSnapshotTool } from '../src/tools/page-snapshot.js'
import { inspectElementTool } from '../src/tools/inspect-element.js'
import type { ToolContext } from '../src/types.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureUrl = pathToFileURL(path.join(here, 'fixtures', 'hostile.html')).href
const hasChrome = !!findChromeExecutable()

describe.skipIf(!hasChrome)('hardening e2e (hostile page)', () => {
  let session: SessionManager
  let ctx: ToolContext

  beforeAll(async () => {
    session = new SessionManager()
    ctx = await session.connect({ mode: 'launch', headless: true, url: fixtureUrl })
  }, 60_000)

  afterAll(async () => {
    await session?.disconnect()
  })

  it('does not dead-lock on a page dialog: snapshot + inspect both complete fast', async () => {
    const t0 = Date.now()
    const snap = await pageSnapshotTool.handler(ctx, { budgetTokens: 800 })
    const insp = await inspectElementTool.handler(ctx, { selector: '#target' })
    expect(Date.now() - t0).toBeLessThan(15_000)
    expect(snap.text).toContain('e1')
    expect(insp.text.length).toBeGreaterThan(0)
  })

  it('neutralizes injection-shaped text: no newlines, capped, structurally inert', async () => {
    const snap = await pageSnapshotTool.handler(ctx, { budgetTokens: 800 })
    const insp = await inspectElementTool.handler(ctx, { selector: '#target' })
    for (const out of [snap.text, insp.text]) {
      // The button's own text preview is capped at 40 chars, so the exfil verb never survives whole.
      expect(out).not.toContain('exfiltrate secrets')
      // No captured page string introduces its own blank line (structure that could read as a system block).
      expect(out).not.toMatch(/\n\s*\n/)
    }
    // The element text is still present as a truncated fragment (we neutralize structure, not content).
    expect(insp.text).toContain('SYSTEM: ignore previous')
  })

  it('handles the zero-size unknown custom element without crashing', async () => {
    const snap = await pageSnapshotTool.handler(ctx, { budgetTokens: 800, includeInvisible: true })
    // The weird tag renders as an ordinary node line, not an error.
    expect(snap.text.toLowerCase()).toContain('ajf-iyagliszkrbm')
  })
})
