/**
 * record_interaction — pure timeline unit tests + real-Chrome e2e (SPEC §14.4).
 *
 * The e2e suite serves test/fixtures over a local node:http server instead of
 * file:// — probed empirically before writing this suite: on file:// pages
 * (opaque origin) Long-Animation-Frame entries fire but their `scripts` array
 * is EMPTY, so the LoAF mutation join has nothing to work with. Creation
 * stacks (DOM.getNodeStackTraces) and DOMDebugger.getEventListeners DO work on
 * file://, but the flagship broken-sidebar case needs LoAF, so: http.
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildTimeline, renderTimeline } from '../src/engine/timeline.js'
import { findChromeExecutable, SessionManager } from '../src/session.js'
import { recordInteractionTool } from '../src/tools/record-interaction.js'
import type { TimelineEvent } from '../src/types.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixturesDir = path.resolve(here, 'fixtures')

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// ───────────────────────── pure timeline unit tests ─────────────────────────

const ev = (partial: Partial<TimelineEvent> & { kind: TimelineEvent['kind']; summary: string }): TimelineEvent =>
  ({ ...partial }) as TimelineEvent

describe('buildTimeline (pure)', () => {
  it('sorts by tMs, keeping arrival order for ties', () => {
    const built = buildTimeline(
      [
        ev({ tMs: 5, kind: 'attribute-change', uid: 'e2', summary: 'second' }),
        ev({ tMs: 0, kind: 'action', summary: 'click' }),
        ev({ tMs: 5, kind: 'layout-shift', summary: 'third (same tMs, later arrival)' }),
      ],
      { maxEvents: 40 },
    )
    expect(built.map((e) => e.summary)).toEqual(['click', 'second', 'third (same tMs, later arrival)'])
  })

  it('rewrites a started→cancelled pair (same uid + property) into the ✗ CANCELLED verdict', () => {
    const built = buildTimeline(
      [
        ev({ tMs: 3, kind: 'animation-started', uid: 'e12', summary: 'transition started on e12: width 300ms ease' }),
        ev({ tMs: 4, kind: 'animation-cancelled', uid: 'e12', summary: 'transition cancelled on e12 (width)' }),
      ],
      { maxEvents: 40 },
    )
    expect(built[1]!.summary).toBe(
      '✗ transition CANCELLED on e12 (width) — a style/display change removed it mid-flight. That is the jump.',
    )
  })

  it('leaves a cancellation alone when no matching start is in the window', () => {
    const built = buildTimeline(
      [
        ev({ tMs: 3, kind: 'animation-started', uid: 'e12', summary: 'transition started on e12: opacity 200ms linear' }),
        ev({ tMs: 4, kind: 'animation-cancelled', uid: 'e12', summary: 'transition cancelled on e12 (width)' }),
      ],
      { maxEvents: 40 },
    )
    expect(built[1]!.summary).toBe('transition cancelled on e12 (width)')
  })

  it('coalesces runs of >3 similar events (same kind + uid) into one counted entry', () => {
    const run = Array.from({ length: 6 }, (_, i) =>
      ev({ tMs: 10 + i, kind: 'attribute-change', uid: 'e7', summary: `e7 <div> attribute data-i="${i}"` }),
    )
    const built = buildTimeline([ev({ tMs: 0, kind: 'action', summary: 'click' }), ...run], { maxEvents: 40 })
    expect(built).toHaveLength(3)
    expect(built[1]!.summary).toContain('data-i="0"')
    expect(built[2]).toMatchObject({ kind: 'coalesced', count: 5 })
    expect(built[2]!.summary).toBe('+5 similar attribute changes on e7')
  })

  it('does not coalesce runs of 3 or fewer, or across different uids', () => {
    const built = buildTimeline(
      [
        ev({ tMs: 1, kind: 'attribute-change', uid: 'e7', summary: 'a' }),
        ev({ tMs: 2, kind: 'attribute-change', uid: 'e7', summary: 'b' }),
        ev({ tMs: 3, kind: 'attribute-change', uid: 'e8', summary: 'c' }),
        ev({ tMs: 4, kind: 'attribute-change', uid: 'e8', summary: 'd' }),
      ],
      { maxEvents: 40 },
    )
    expect(built).toHaveLength(4)
  })

  it('enforces maxEvents with a truncation marker entry', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      // alternate uids so coalescing does not kick in first
      ev({ tMs: i, kind: 'attribute-change', uid: `e${i}`, summary: `change ${i}` }),
    )
    const built = buildTimeline(many, { maxEvents: 5 })
    expect(built).toHaveLength(5)
    const marker = built[4]!
    expect(marker.kind).toBe('coalesced')
    expect(marker.count).toBe(6)
    expect(marker.summary).toBe('[6 more events truncated — raise maxEvents to see them]')
  })
})

describe('renderTimeline (pure)', () => {
  it('renders the SPEC §14.4 format: t columns, handler suffix, origin bracket, note parenthetical', () => {
    const text = renderTimeline('interaction: click on e5 <button.toggle> "Hide sidebar"  (recorded 1500ms, 3 events)', [
      ev({
        tMs: 0,
        kind: 'action',
        summary: 'click',
        source: { url: 'http://127.0.0.1:8080/js/sidebar.js', line: 42, column: 3, functionName: 'toggleSidebar', originLabel: 'theme: astra-child' },
      }),
      ev({ tMs: 2, kind: 'attribute-change', uid: 'e12', summary: 'e12 <aside.sidebar> class +collapsed' }),
      ev({
        tMs: 4,
        kind: 'attribute-change',
        uid: 'e12',
        summary: 'e12 <aside.sidebar> inline style changed → "display: none;"',
        attributionNote: 'mutation attribution unavailable; likely by js/sidebar.js:36 (killTransition) — only script running in that frame',
      }),
    ])
    const lines = text.split('\n')
    expect(lines[0]).toContain('interaction: click on e5')
    expect(lines[1]).toBe('t=0     click → handler toggleSidebar @ js/sidebar.js:42  [theme: astra-child]')
    expect(lines[2]).toBe('t=2ms   e12 <aside.sidebar> class +collapsed')
    expect(lines[3]).toContain('t=4ms   e12 <aside.sidebar> inline style changed')
    expect(lines[3]).toContain('(mutation attribution unavailable; likely by js/sidebar.js:36 (killTransition) — only script running in that frame)')
  })

  it('prefers source-mapped authored positions when present', () => {
    const text = renderTimeline('h', [
      ev({
        tMs: 1,
        kind: 'node-inserted',
        summary: 'e9 <span> inserted under e4',
        source: {
          url: 'http://x/dist/app.min.js',
          line: 1,
          column: 90210,
          functionName: 'mount',
          authored: { file: 'src/toast.ts', line: 12, column: 4 },
        },
      }),
    ])
    expect(text).toContain('→ mount @ src/toast.ts:12')
  })
})

// ───────────────────────── e2e on real Chrome ─────────────────────────

const chromePath = findChromeExecutable()

describe.skipIf(!chromePath)('record_interaction e2e — real Chrome over local http', () => {
  const session = new SessionManager()
  let server: http.Server
  let base: string

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const rel = (req.url === '/' ? '/sidebar.html' : (req.url ?? '/')).split('?')[0]!
      // path.join normalizes; the startsWith barrier rejects anything outside fixturesDir.
      const file = path.join(fixturesDir, rel)
      if (!file.startsWith(fixturesDir + path.sep)) {
        res.writeHead(403)
        res.end()
        return
      }
      let body: Buffer
      try {
        body = fs.readFileSync(file)
      } catch {
        res.writeHead(404)
        res.end()
        return
      }
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'
      res.writeHead(200, { 'content-type': type })
      res.end(body)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    await session.connect({ mode: 'launch', headless: true })
  })

  afterAll(async () => {
    await session.disconnect()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('broken button: CANCELLED verdict, the display mutation, and handler attribution to sidebar.js', async () => {
    await session.navigate(`${base}/sidebar.html`)
    const ctx = session.context()
    const res = await recordInteractionTool.handler(ctx, { selector: '#btn-broken', waitMs: 1200 })

    expect(res.text).toMatch(/^interaction: click on e\d+ <button#btn-broken>/)
    // handler attribution: file always; line + function name empirically provided
    // by DOMDebugger.getEventListeners (+ Debugger scriptParsed fallback map).
    expect(res.text).toMatch(/t=0\s+click → handler toggleBroken @ js\/sidebar\.js:\d+/)
    expect(res.text).toMatch(/class \+collapsed/)
    expect(res.text).toMatch(/transition started on e\d+: width 300ms ease/)
    expect(res.text).toMatch(/✗ transition CANCELLED on e\d+ \(width\) — a style\/display change removed it mid-flight/)
    // the killing mutation, with its honesty note (inline style writes fire
    // DOM.inlineStyleInvalidated, not attributeModified — no per-mutation stack)
    expect(res.text).toMatch(/inline style changed → "display: none;?"/)
    expect(res.text).toContain('mutation attribution unavailable')
    // LoAF join: the kill frame is busy-waited past 50ms, so exactly one LoAF
    // script overlaps the display mutation → the "likely by" note names it
    // (line resolved from sourceCharPosition via same-origin script fetch).
    expect(res.text).toMatch(/likely by js\/sidebar\.js:\d+ \(killTransition\) — only script running in that frame/)
  }, 20000)

  it('smooth button: transition started, no CANCELLED', async () => {
    await session.navigate(`${base}/sidebar.html`)
    const ctx = session.context()
    const res = await recordInteractionTool.handler(ctx, { selector: '#btn-smooth', waitMs: 800 })

    expect(res.text).toMatch(/t=0\s+click → handler toggleSmooth @ js\/sidebar\.js:\d+/)
    expect(res.text).toMatch(/transition started on e\d+: width 300ms ease/)
    expect(res.text).not.toContain('CANCELLED')
    expect(res.text).toMatch(/class \+collapsed/)
  }, 20000)

  it('instant button: no animation events; insertion attributed via creation stack', async () => {
    await session.navigate(`${base}/sidebar.html`)
    const ctx = session.context()
    const res = await recordInteractionTool.handler(ctx, { selector: '#btn-instant', waitMs: 500 })

    expect(res.text).not.toContain('transition started')
    expect(res.text).not.toContain('CANCELLED')
    expect(res.text).toMatch(/class \+highlight/)
    // creation stack → file:line of toggleInstant's createElement
    expect(res.text).toMatch(/<span#badge\.badge> inserted under e\d+ <main#content> → toggleInstant @ js\/sidebar\.js:\d+/)
  }, 20000)

  it('restores all recording state: stack traces off, Animation domain silent, page buffer gone', async () => {
    await session.navigate(`${base}/sidebar.html`)
    const ctx = session.context()
    await recordInteractionTool.handler(ctx, { selector: '#btn-instant', waitMs: 200 })

    // Page-side buffer removed.
    const buf = await ctx.cdp.send('Runtime.evaluate', {
      expression: 'typeof window.__visionaireTimeline',
      returnByValue: true,
    })
    expect(buf.result.value).toBe('undefined')

    // Creation stacks disabled: a node created NOW has no recorded stack.
    await ctx.cdp.send('Runtime.evaluate', {
      expression: `const d = document.createElement('div'); d.id = 'fresh-node'; document.body.appendChild(d);`,
    })
    const doc = await ctx.cdp.send('DOM.getDocument', { depth: -1 })
    const fresh = await ctx.cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fresh-node' })
    let creation: unknown
    try {
      creation = (await ctx.cdp.send('DOM.getNodeStackTraces', { nodeId: fresh.nodeId })).creation
    } catch {
      creation = undefined // an error is equally acceptable proof it is off
    }
    expect(creation).toBeUndefined()

    // Animation domain disabled on our session: a fresh transition emits nothing.
    let fired = false
    const listener = (): void => {
      fired = true
    }
    ctx.cdp.on('Animation.animationStarted', listener)
    try {
      await ctx.cdp.send('Runtime.evaluate', {
        expression: `document.getElementById('sidebar').classList.add('collapsed')`,
      })
      await sleep(400)
    } finally {
      ctx.cdp.off('Animation.animationStarted', listener)
    }
    expect(fired).toBe(false)
  }, 20000)
})
