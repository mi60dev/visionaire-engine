/**
 * measure_element e2e — real Chrome over test/fixtures/glyph.html.
 * Auto-skips when no Chrome is installed. Drives the ToolDef directly with its
 * own SessionManager, mirroring the other *.e2e.test.ts files.
 *
 * Fixture contract (test/fixtures/glyph.html) — LOAD-BEARING:
 *   button.close  32x32, "×" left-aligned (text-align:left + text-indent) → ink left of center
 *   button.ctrl   40x40, "×" flex-centered → both axes ~0
 *   #ref-box      40x40 at left:160 (control at left:100) → -60px horizontal center delta
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findChromeExecutable, SessionManager } from '../src/session.js'
import { measureElementTool } from '../src/tools/measure-element.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureUrl = (name: string): string => pathToFileURL(path.resolve(here, 'fixtures', name)).href

const chromePath = findChromeExecutable()

/** Parse "±N.Npx" out of a "horizontal:" / "vertical:" line. */
function delta(text: string, axis: 'horizontal' | 'vertical'): number {
  const line = text.split('\n').find((l) => l.trim().startsWith(`${axis}:`))
  expect(line, `expected a ${axis} line in:\n${text}`).toBeDefined()
  const m = line!.match(/([+-]?\d+(?:\.\d+)?)px/)
  expect(m, `expected a px delta in "${line}"`).toBeTruthy()
  return Number(m![1])
}

/** Parse "WxH" out of a "content box:" / "text ink:" line. */
function dims(text: string, label: string): { w: number; h: number } {
  const line = text.split('\n').find((l) => l.trim().startsWith(label))
  expect(line, `expected a "${label}" line in:\n${text}`).toBeDefined()
  const m = line!.match(/(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)/)
  expect(m).toBeTruthy()
  return { w: Number(m![1]), h: Number(m![2]) }
}

describe.skipIf(!chromePath)('measure_element e2e — real Chrome', () => {
  const session = new SessionManager()

  beforeAll(async () => {
    await session.connect({ mode: 'launch', headless: true })
    await session.navigate(fixtureUrl('glyph.html'))
  })

  afterAll(async () => {
    await session.disconnect()
  })

  async function run(args: Record<string, unknown>): Promise<string> {
    const res = await measureElementTool.handler(session.context(), args)
    return res.text
  }

  it('reports a nonzero horizontal delta with a shift hint for the off-center glyph', async () => {
    const text = await run({ selector: 'button.close' })
    // header + boxes present
    expect(text).toMatch(/^element e\d+ <button\.close>/)
    expect(text).toContain('content box: 30x30') // 32 - 1 - 1 border on each axis
    expect(text).toContain('centering (text ink vs content box)')

    // The glyph is left-aligned inside its content box → ink sits well LEFT of
    // the content-box center: a clear nonzero horizontal delta with an actionable
    // shift-right hint.
    const dx = delta(text, 'horizontal')
    expect(Math.abs(dx)).toBeGreaterThan(2)
    expect(dx).toBeLessThan(0) // ink is left of center
    expect(text.toLowerCase()).toContain('shift content right')
    expect(text).toContain('font 16px "Arial"')
  })

  it('reports ~0 on both axes for the flex-centered control', async () => {
    const text = await run({ selector: 'button.ctrl' })
    const dx = delta(text, 'horizontal')
    const dy = delta(text, 'vertical')
    expect(Math.abs(dx)).toBeLessThan(1)
    expect(Math.abs(dy)).toBeLessThan(1.5)
    expect(text).toMatch(/centered/i)
  })

  it('the text ink box differs from the content box (true glyph extents, not the padded box)', async () => {
    const text = await run({ selector: 'button.close' })
    const content = dims(text, 'content box:')
    const ink = dims(text, 'text ink:')
    // A single "×" ink box is far smaller than the 30x27 content box.
    expect(ink.w).toBeLessThan(content.w)
    expect(ink.h).toBeLessThan(content.h)
    expect(ink.w).toBeGreaterThan(0)
  })

  it('reports the center delta against a reference element', async () => {
    const text = await run({ selector: 'button.ctrl', referenceSelector: '#ref-box' })
    expect(text).toMatch(/alignment vs reference e\d+ <div>/)
    // control center x=120, ref center x=180 → target is 60px LEFT of reference.
    const line = text.slice(text.indexOf('alignment vs reference'))
    const hx = delta(line, 'horizontal')
    expect(hx).toBeCloseTo(-60, 0)
    // both at top:100 height:40 → vertical centers coincide.
    const hy = delta(line, 'vertical')
    expect(Math.abs(hy)).toBeLessThan(0.5)
  })

  it('handles an element with no text (no ink box, no centering section)', async () => {
    const text = await run({ selector: '#ref-box' })
    expect(text).toContain('text ink: (no text to measure)')
    expect(text).not.toContain('centering (text ink vs content box)')
  })

  it('rejects unknown targets with actionable messages', async () => {
    await expect(run({ uid: 'e999' })).rejects.toThrow(/page_snapshot/)
    await expect(run({ selector: '#nope' })).rejects.toThrow(/No element matches selector/)
    await expect(run({})).rejects.toThrow(/exactly one of/i)
  })
})
