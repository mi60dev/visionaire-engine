/**
 * explain_animations e2e — real Chrome over test/fixtures/animations.html.
 * Auto-skips when no Chrome is installed. Drives the ToolDef directly.
 *
 * Fixture line-number contract (1-based as rendered; CDP source ranges are
 * 0-based). LOAD-BEARING — keep in sync with test/fixtures/css/anims.css:
 *
 *   css/anims.css:7    @keyframes spin { … }                       keyframes attribution line
 *   css/anims.css:13   #spinner { animation: spin 1.2s … }         census: CSSAnimation running
 *   css/anims.css:16   .box { transition: height 300ms ease; }     the auto-height trap (R2)
 *   css/anims.css:19   #slide { transition: transform 200ms … }    clean case, zero ⚠
 *   css/anims.css:23   #pulse { animation: pulse 1s … infinite; }  no reduced-motion guard (R5)
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findChromeExecutable, SessionManager } from '../src/session.js'
import { explainAnimationsTool } from '../src/tools/explain-animations.js'

const KEYFRAMES_SPIN_LINE = 7
const BOX_TRANSITION_LINE = 16

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureUrl = (name: string): string => pathToFileURL(path.resolve(here, 'fixtures', name)).href

const chromePath = findChromeExecutable()

describe.skipIf(!chromePath)('explain_animations e2e — real Chrome', () => {
  const session = new SessionManager()

  beforeAll(async () => {
    await session.connect({ mode: 'launch', headless: true })
    await session.navigate(fixtureUrl('animations.html'))
  })

  afterAll(async () => {
    await session.disconnect()
  })

  async function explain(selector: string): Promise<string> {
    const res = await explainAnimationsTool.handler(session.context(), { selector })
    return res.text
  }

  it('census reports the running spinner', async () => {
    const text = await explain('#spinner')
    expect(text).toContain("CSSAnimation 'spin'")
    expect(text).toContain('running')
    expect(text).toMatch(/animates[^\n]*transform/)
    // Infinite iterations survive the returnByValue JSON round-trip as '∞'.
    expect(text).toContain('×∞')
  })

  it('attributes @keyframes spin to anims.css with its line number', async () => {
    const text = await explain('#spinner')
    expect(text).toMatch(/@keyframes spin[^\n]*animates transform/)
    expect(text).toMatch(new RegExp(`anims\\.css:${KEYFRAMES_SPIN_LINE}\\b`))
    // file:// sheet with real line numbers → 'line' granularity bracket.
    expect(text).toContain('[line')
  })

  it('flags the height:auto transition trap on the idle .box', async () => {
    const text = await explain('#accordion')
    // Declared-but-idle half: the transition surfaces with file:line even with no census.
    expect(text).toMatch(/active now:\s*none/)
    expect(text).toMatch(/transition: height[^\n]*300ms/)
    expect(text).toMatch(new RegExp(`anims\\.css:${BOX_TRANSITION_LINE}\\b`))
    // The R2 finding names the trap.
    const warning = text.split('\n').find((l) => l.includes('⚠'))
    expect(warning, `no ⚠ finding in:\n${text}`).toBeTruthy()
    expect(warning).toContain("'height'")
    expect(warning).toContain('cannot interpolate to/from auto')
  })

  it('clean transform transition yields no warnings, and R6 points at record_interaction', async () => {
    const text = await explain('#slide')
    expect(text).not.toContain('⚠')
    expect(text).toMatch(/transition: transform[^\n]*200ms/)
    // R6 honesty note: nothing active does not mean nothing animates.
    expect(text).toMatch(/active now:\s*none/)
    expect(text).toContain('record_interaction')
  })

  it('R5: informs when prefers-reduced-motion: reduce is ignored (emulated)', async () => {
    const ctx = session.context()
    try {
      await ctx.cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      })
      const text = await explain('#pulse')
      expect(text).toContain("CSSAnimation 'pulse'")
      expect(text).toContain('prefers-reduced-motion')
      expect(text).toContain('informational')
    } finally {
      // Restore: an empty value clears the emulated media feature.
      await ctx.cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: '' }],
      })
    }
  })
})
