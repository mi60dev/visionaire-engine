/**
 * evaluate e2e — real headless Chrome, an existing fixture. Covers the escape
 * hatch's contract and the CDP edge cases probed during the build:
 *   • a simple expression returns its value (document.title, 1+2)
 *   • a bare object literal round-trips as JSON (block-vs-object wrapping)
 *   • an IIFE returning an object round-trips
 *   • a throwing expression returns the error message, not a crash
 *   • awaitPromise resolves a Promise
 *   • an oversize result is truncated with a note
 *   • non-serializable values (DOM node) are described, not JSON
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findChromeExecutable, SessionManager } from '../src/session.js'
import { evaluateTool } from '../src/tools/evaluate.js'
import type { ToolContext } from '../src/types.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureUrl = pathToFileURL(path.resolve(here, 'fixtures', 'sidebar.html')).href
const chromePath = findChromeExecutable()

describe.skipIf(!chromePath)('evaluate e2e — real Chrome', () => {
  const session = new SessionManager()
  let ctx: ToolContext

  beforeAll(async () => {
    ctx = await session.connect({ mode: 'launch', headless: true, url: fixtureUrl })
  }, 60_000)

  afterAll(async () => {
    await session.disconnect()
  })

  async function run(args: Record<string, unknown>): Promise<string> {
    const res = await evaluateTool.handler(ctx, args)
    return res.text
  }

  it('returns a simple expression value (document.title)', async () => {
    const text = await run({ expression: 'document.title' })
    // sidebar.html <title> — JSON-encoded string result.
    expect(text).toBe(JSON.stringify('Sidebar fixture — record_interaction (SPEC §14.4)'))
  })

  it('evaluates arithmetic (1+2 → 3)', async () => {
    expect(await run({ expression: '1+2' })).toBe('3')
  })

  it('round-trips a bare object literal as JSON', async () => {
    const text = await run({ expression: '{ a: 1, b: [2, 3], c: "x" }' })
    expect(JSON.parse(text)).toEqual({ a: 1, b: [2, 3], c: 'x' })
  })

  it('still evaluates a genuine block (last expression) when brace-wrapping would break it', async () => {
    // `{ const a = 2; a * 3; }` is a real block, not an object literal — wrapping in
    // parens is a SyntaxError, so the tool must fall back to the raw source → 6.
    expect(await run({ expression: '{ const a = 2; a * 3; }' })).toBe('6')
  })

  it('round-trips an IIFE returning an object', async () => {
    const text = await run({
      expression: '(() => ({ w: window.innerWidth, ok: true, list: [1, 2] }))()',
    })
    const parsed = JSON.parse(text)
    expect(parsed.ok).toBe(true)
    expect(parsed.list).toEqual([1, 2])
    expect(typeof parsed.w).toBe('number')
  })

  it('returns a throwing expression as an error message, not a crash', async () => {
    const text = await run({ expression: 'throw new Error("boom custom msg")' })
    expect(text).toContain('evaluate error:')
    expect(text).toContain('boom custom msg')
    // First line only — no multiline stack leaking into the result.
    expect(text.split('\n')).toHaveLength(1)
  })

  it('surfaces a ReferenceError message rather than crashing', async () => {
    const text = await run({ expression: 'definitelyNotDefined.foo' })
    expect(text).toContain('evaluate error:')
    expect(text).toMatch(/definitelyNotDefined is not defined/)
  })

  it('awaits a resolved Promise (awaitPromise default true)', async () => {
    expect(await run({ expression: 'Promise.resolve(42)' })).toBe('42')
  })

  it('surfaces a rejected Promise as an error message', async () => {
    const text = await run({ expression: 'Promise.reject(new Error("nope"))' })
    expect(text).toContain('evaluate error:')
    expect(text).toContain('nope')
  })

  it('truncates an oversize result with a note', async () => {
    // Build a ~40k-char JSON array in-page.
    const text = await run({ expression: 'Array.from({ length: 5000 }, (_, i) => i)' })
    expect(text).toContain('[truncated:')
    expect(text).toContain('capped at')
    // Capped near the limit, not the full ~28k chars.
    expect(text.length).toBeLessThan(6300)
  })

  it('describes a non-serializable DOM node instead of returning {}', async () => {
    const text = await run({ expression: 'document.getElementById("sidebar")' })
    expect(text).toContain('non-serializable')
    expect(text).toContain('node')
    // The description carries the element's identity (aside#sidebar…).
    expect(text).toContain('sidebar')
    // It must NOT collapse to an empty object, which is the returnByValue:true trap.
    expect(text).not.toBe('{}')
  })

  it('reports undefined and null distinctly', async () => {
    expect(await run({ expression: 'undefined' })).toBe('undefined')
    expect(await run({ expression: 'null' })).toBe('null')
  })

  it('handles unserializable numeric values (Infinity)', async () => {
    expect(await run({ expression: '1/0' })).toBe('Infinity')
  })

  it('can force UI state and read it back (the escape-hatch use case)', async () => {
    // Force the collapsed state the sidebar fixture toggles, then read it back —
    // exactly what the field report needed and no purpose-built tool covers.
    // (Assert on the class + the target width rule rather than the live computed
    // width, which is mid-transition on this fixture — the point is that the
    // agent could force state and measure at all, deterministically.)
    const text = await run({
      expression:
        '(() => { const s = document.getElementById("sidebar"); s.classList.add("collapsed"); ' +
        'return { collapsed: s.classList.contains("collapsed"), transition: getComputedStyle(s).transitionProperty }; })()',
    })
    expect(JSON.parse(text)).toEqual({ collapsed: true, transition: 'width' })
    // Clean up the injected state so we do not disturb other assertions.
    await run({ expression: 'document.getElementById("sidebar").classList.remove("collapsed")' })
  })

  it('aborts a runaway expression at the timeout rather than hanging', async () => {
    const t0 = Date.now()
    const text = await run({ expression: 'while (true) {}', timeoutMs: 300 })
    expect(Date.now() - t0).toBeLessThan(10_000)
    expect(text).toContain('evaluate error:')
    expect(text).toMatch(/timeout|aborted/i)
  })

  it('rejects an empty expression with an actionable error', async () => {
    await expect(run({ expression: '   ' })).rejects.toThrow(/expression is empty/)
  })
})
