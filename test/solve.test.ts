/**
 * solve gateway: plan/arg contracts (every step's args must pass the target
 * tool's own schema — v1.0.0 shipped with every scenario broken on this),
 * routing of realistic phrasings, element-reference classification, and a
 * live run against the cascade fixture.
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { inferProperty, routeQuery } from '../src/keyword-router.js'
import { SCENARIOS } from '../src/scenarios.js'
import { findChromeExecutable, SessionManager } from '../src/session.js'
import { classifyElementRef, solveTool, TOOL_HANDLERS } from '../src/tools/solve.js'

describe('scenario plans', () => {
  const inputs = [
    { intent: 'x', target: { uid: 'e3' } },
    { intent: 'text is too tall and centered', target: { selector: '.a' }, property: 'color', viewport: { width: 375, height: 700 }, selector: '.btn' },
    { intent: 'focus ring', target: { x: 10, y: 20 }, breakpoints: [320, 1024] },
  ]
  for (const s of SCENARIOS) {
    it(`${s.id}: every tool step passes its tool's schema`, () => {
      for (const input of inputs) {
        for (const step of s.plan(input)) {
          if (step.kind === 'viewport' || step.kind === 'sweep') continue
          const def = TOOL_HANDLERS[step.tool]
          expect(def, `${s.id} → unknown tool ${step.tool}`).toBeTruthy()
          const r = z.object(def!.inputSchema).strict().safeParse(step.args)
          expect(r.success, `${s.id} → ${step.tool} ${JSON.stringify(step.args)}: ${r.success ? '' : r.error.message}`).toBe(true)
        }
      }
    })
  }
  it('no scenario steps into connect/set_viewport as a ToolDef', () => {
    for (const s of SCENARIOS) for (const st of s.plan({ intent: 'x', target: { uid: 'e1' } })) expect(['connect', 'set_viewport']).not.toContain(st.kind ? '' : st.tool)
  })
})

describe('router', () => {
  const cases: Array<[string, string]> = [
    ['why is the header button blue instead of white', 'color-wrong'],
    ['the background of the card is the wrong color', 'color-wrong'],
    ['modal hidden behind overlay', 'overlap-z-index'],
    ['z-index not working on my tooltip', 'overlap-z-index'],
    ['dropdown appears underneath the hero image', 'overlap-z-index'],
    ['flex items not centered', 'alignment-off'],
    ['the logo is not vertically centered', 'alignment-off'],
    ['menu breaks at 768px', 'responsive-broken'],
    ['layout is broken on mobile', 'responsive-broken'],
    ['click on submit does nothing', 'click-not-working'],
    ['font looks wrong in the footer', 'font-wrong'],
    ['heading should be bold', 'font-wrong'],
    ['my padding style won\'t apply', 'style-not-apply'],
    ['why is my rule overridden', 'style-not-apply'],
    ['which file sets the margin on .card', 'what-rule-sets-this'],
    ['the sidebar is too wide', 'element-wrong-size'],
    ['image is squished', 'element-wrong-size'],
    ['too much space between the cards', 'spacing-wrong'],
    ['the error message is invisible', 'element-hidden'],
    ['the cookie banner disappeared', 'element-hidden'],
    ['dropdown menu is cut off', 'clipped-cutoff'],
    ['content overflows the container', 'clipped-cutoff'],
    ['product title is truncated with ellipsis', 'text-truncated'],
    ['fade-in animation is janky', 'animation-broken'],
    ['transition does not run', 'animation-broken'],
    ['hover color on links is wrong', 'hover-state-wrong'],
    ['the sticky header jumps when scrolling', 'positioned-wrong'],
    ['grid has 3 columns instead of 4', 'flex-grid-layout'],
    ['find the subscribe button', 'find-element'],
    ['where is the newsletter form', 'find-element'],
    ['give me an overview of the page', 'page-overview'],
  ]
  for (const [q, id] of cases) {
    it(`"${q}" → ${id}`, () => {
      const r = routeQuery(q)
      expect(r.best?.scenario.id, JSON.stringify(r.candidates.map((c) => [c.scenario.id, c.score]))).toBe(id)
    })
  }
  it('gibberish and empty input route nowhere', () => {
    expect(routeQuery('').best).toBeUndefined()
    expect(routeQuery('a').best).toBeUndefined()
    expect(routeQuery('asdf qwer').best).toBeUndefined()
  })
  it('infers properties from sentences', () => {
    expect(inferProperty('why is the padding-top 40px')).toBe('padding')
    expect(inferProperty('background is grey')).toBe('background-color')
    expect(inferProperty('z-index not working')).toBe('z-index')
    expect(inferProperty('set justify-content: center')).toBe('justify-content')
    expect(inferProperty('it looks broken')).toBeUndefined()
  })
})

describe('element references', () => {
  it.each([
    ['e12', 'uid'],
    ['f3', 'uid'],
    ['.hero .btn', 'selector'],
    ['#main', 'selector'],
    ['button', 'selector'],
    ['nav > a:first-child', 'selector'],
    ['Subscribe button', 'text'],
    ['the newsletter signup', 'text'],
  ])('%s → %s', (ref, kind) => expect(classifyElementRef(ref).kind).toBe(kind))
})

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureUrl = (name: string): string => pathToFileURL(path.resolve(here, 'fixtures', name)).href
const chromePath = findChromeExecutable()

describe.skipIf(!chromePath)('solve — live', () => {
  const session = new SessionManager()
  const solve = solveTool(session)
  const run = (args: Record<string, unknown>) => solve.handler(undefined as never, args)

  beforeAll(async () => {
    await session.connect({ mode: 'launch', headless: true, url: fixtureUrl('cascade.html') })
  })
  afterAll(async () => {
    await session.disconnect()
  })

  it('answers a color question with the winning declaration', async () => {
    const r = await run({ intent: 'why is the Get started link white', context: { element: '.hero-cta .btn' } })
    expect(r.text).toMatch(/^solve → color-wrong/)
    expect(r.text).toContain('── explain_styles ──')
    expect(r.text).toContain('NEXT:')
    expect(r.text).not.toContain('✗ ──\nProvide exactly one')
  })

  it('resolves a text description to a uid', async () => {
    const r = await run({ intent: 'why is there margin under it', context: { element: 'Get started link' } })
    expect(r.text).toMatch(/target: e\d+ — found by text "Get started link"/)
    expect(r.text).toContain('theme.css:10')
  })

  it('asks for the element with a uid outline instead of failing', async () => {
    const r = await run({ intent: 'the button is the wrong color' })
    expect(r.text).toContain('NEED:')
    expect(r.text).toMatch(/\be\d+\b/)
  })

  it('lists candidates when it cannot route', async () => {
    const r = await run({ intent: 'hmm' })
    expect(r.text).toMatch(/Could not map/)
  })

  it('expert mode validates args against the tool schema', async () => {
    const bad = await run({ intent: 'x', tool: 'explain_styles', args: { element: '.btn' } })
    expect(bad.text).toMatch(/Invalid args for explain_styles[\s\S]*accepts: uid, selector, x, y, property/)
    const good = await run({ intent: 'x', tool: 'explain_styles', args: { selector: '.hero-cta .btn', property: 'margin-bottom' } })
    expect(good.text).toContain('theme.css:10')
  })

  it('rejects malformed input without throwing', async () => {
    const r = await run({ context: {} })
    expect(r.text).toMatch(/Invalid solve input: intent/)
  })
})

describe.skipIf(!chromePath)('solve — first call in a fresh session', () => {
  it('resolves a text-found uid before any DOM.getDocument (field report)', async () => {
    const session = new SessionManager()
    try {
      await session.connect({ mode: 'launch', headless: true, url: fixtureUrl('cascade.html') })
      const r = await solveTool(session).handler(undefined as never, {
        intent: 'why is there margin under it',
        context: { element: 'Get started link' },
      })
      expect(r.text).not.toMatch(/Document needs to be requested first/)
      expect(r.text).toContain('theme.css:10')
      // A navigation invalidates the requested document — the next first call must still work.
      await session.navigate(fixtureUrl('cascade.html'))
      const r2 = await solveTool(session).handler(undefined as never, { intent: 'why is there margin under it', context: { element: 'Get started link' } })
      expect(r2.text).toContain('theme.css:10')
    } finally {
      await session.disconnect()
    }
  })
})
