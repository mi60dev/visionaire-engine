/**
 * get_listeners e2e — real Chrome, headless, file:// fixtures (listener
 * attribution works on file:// pages — verified empirically; the LoAF
 * opaque-origin limitation applies to record_interaction, not here).
 *
 * Fixture line-number contract (1-based as rendered; CDP positions are
 * 0-based). LOAD-BEARING — keep in sync with test/fixtures/js/handlers.js
 * and test/fixtures/listeners.html:
 *
 *   js/handlers.js:7    function handleDirectClick    click on #direct-btn
 *   js/handlers.js:11   function handleWheelPassive   wheel {passive:true} on #scroll-area
 *   js/handlers.js:15   function handleSaveOnce       click {once:true} on #once-btn
 *   js/handlers.js:19   function handleDelegatedClick document-level click (vanilla delegation)
 *   js/jquery.min.js:1  jQueryRootHandler             document-level click {capture} (jquery-flavored URL)
 *   listeners.html:12   onclick="…"                   inline attribute on #inline-btn
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findChromeExecutable, SessionManager } from '../src/session.js'
import { getListenersTool } from '../src/tools/get-listeners.js'

const HANDLERS_DIRECT_LINE = 7
const HANDLERS_WHEEL_LINE = 11
const HANDLERS_ONCE_LINE = 15
const HANDLERS_DELEGATED_LINE = 19
const INLINE_ONCLICK_LINE = 12

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureUrl = (name: string): string => pathToFileURL(path.resolve(here, 'fixtures', name)).href

const chromePath = findChromeExecutable()

describe.skipIf(!chromePath)('get_listeners e2e — real Chrome', () => {
  const session = new SessionManager()

  beforeAll(async () => {
    await session.connect({ mode: 'launch', headless: true })
    await session.navigate(fixtureUrl('listeners.html'))
  })

  afterAll(async () => {
    await session.disconnect()
  })

  async function run(args: Record<string, unknown>): Promise<string> {
    const res = await getListenersTool.handler(session.context(), args)
    return res.text
  }

  it('resolves a direct handler to file, plausible line, and function name', async () => {
    const text = await run({ selector: '#direct-btn' })
    expect(text).toMatch(/^listeners on e\d+ <button#direct-btn\.btn> "Save draft"/)
    expect(text).toMatch(
      new RegExp(`click → handleDirectClick @ [^\\n]*js/handlers\\.js:${HANDLERS_DIRECT_LINE}\\b`),
    )
    // A plain click listener has no non-default flags — no flag parens on that line.
    const directLine = text.split('\n').find((l) => l.includes('handleDirectClick'))
    expect(directLine).toBeDefined()
    expect(directLine).not.toMatch(/\(capture|\(once|passive/)
    expect(directLine).toContain('[line]')
  })

  it('always spells out passive for scroll-blocking events (wheel)', async () => {
    const text = await run({ selector: '#scroll-area' })
    expect(text).toMatch(
      new RegExp(`wheel → handleWheelPassive @ [^\\n]*js/handlers\\.js:${HANDLERS_WHEEL_LINE}\\b`),
    )
    expect(text).toContain('passive:true — preventDefault is silently ignored')
  })

  it('renders the once flag only when set', async () => {
    const text = await run({ selector: '#once-btn' })
    expect(text).toMatch(
      new RegExp(`click → handleSaveOnce @ [^\\n]*js/handlers\\.js:${HANDLERS_ONCE_LINE}\\b`),
    )
    expect(text.split('\n').find((l) => l.includes('handleSaveOnce'))).toContain('(once)')
  })

  it('surfaces delegated document-level listeners for an eventType filter, labeling jquery', async () => {
    const text = await run({ selector: '#direct-btn', eventType: 'click' })
    expect(text).toContain(' — click only')
    expect(text).toContain('ancestors (click):')
    // Vanilla delegation: named handler at its real file:line.
    expect(text).toMatch(
      new RegExp(`document → handleDelegatedClick @ [^\\n]*js/handlers\\.js:${HANDLERS_DELEGATED_LINE}\\b`),
    )
    // jquery-flavored URL: delegation label + minified honesty + capture flag.
    const jqLine = text.split('\n').find((l) => l.includes('jquery.min.js'))
    expect(jqLine).toBeDefined()
    expect(jqLine).toContain('delegated (jquery)')
    expect(jqLine).toContain('minified, no map')
    expect(jqLine).toContain('(capture)')
    // Honesty note, verbatim per SPEC §14.2.
    expect(text).toContain(
      'delegated root listener (jquery) — component handler not resolvable at the DOM level; read the component source',
    )
  })

  it('filters element-level listeners too, and says when the chain has none', async () => {
    const text = await run({ selector: '#direct-btn', eventType: 'wheel' })
    expect(text).toContain('(none for wheel on the element itself')
    expect(text).toContain('(none up the chain — document and window included)')
    expect(text).not.toContain('handleDirectClick')
  })

  it('renders inline on*-attribute handlers honestly with the HTML line', async () => {
    const text = await run({ selector: '#inline-btn' })
    expect(text).toMatch(
      new RegExp(`click → inline onclick attribute @ [^\\n]*listeners\\.html:${INLINE_ONCLICK_LINE}\\b`),
    )
    // No fabricated function name for the compiled attribute script.
    expect(text).not.toContain('inlineClicked')
  })

  it('omits the ancestors section when includeAncestors is false', async () => {
    const text = await run({ selector: '#direct-btn', includeAncestors: false })
    expect(text).toContain('handleDirectClick')
    expect(text).not.toContain('ancestors')
    expect(text).not.toContain('handleDelegatedClick')
  })

  it('skips ancestor levels without listeners (body/html/main never appear)', async () => {
    const text = await run({ selector: '#direct-btn' })
    const ancestors = text.slice(text.indexOf('ancestors'))
    expect(ancestors).not.toMatch(/<main|<body|<html/)
    expect(ancestors).toContain('document')
  })

  it('rejects unknown targets with actionable messages', async () => {
    await expect(run({ uid: 'e999' })).rejects.toThrow(/page_snapshot/)
    await expect(run({ selector: '#does-not-exist' })).rejects.toThrow(
      /No element matches selector: #does-not-exist/,
    )
    await expect(run({})).rejects.toThrow(/exactly one of/i)
  })

  it('errors helpfully when the ScriptRegistry is missing from the context', async () => {
    const bare = { ...session.context(), scripts: undefined }
    await expect(getListenersTool.handler(bare, { selector: '#direct-btn' })).rejects.toThrow(
      /reconnect to enable JS attribution/,
    )
  })
})
