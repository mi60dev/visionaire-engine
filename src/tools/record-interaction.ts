/**
 * record_interaction — SPEC §14.4. One interaction, one causal timeline.
 * Five passive capture channels merged and time-aligned:
 *   1. DOM mutation events (getDocument({depth:-1,pierce:true}) FIRST — CDP only
 *      emits mutations for nodes known to the frontend). Empirical: inline style
 *      changes via CSSOM (el.style.x=…) do NOT fire attributeModified — they
 *      fire DOM.inlineStyleInvalidated (no value; final value read post-hoc).
 *   2. Creation stacks for inserted nodes (DOM.setNodeStackTracesEnabled, read
 *      post-hoc via DOM.getNodeStackTraces — recording stays buffer-only).
 *   3. Animation domain events. Empirical: animationStarted carries the animated
 *      property in animation.name for CSSTransitions plus source.backendNodeId/
 *      duration/easing; a transition killed in the same style recalc it was
 *      created in NEVER reaches animationStarted (created→canceled only, with
 *      no target payload — reported honestly).
 *   4. In-page PerformanceObserver buffer: long-animation-frame (script
 *      attribution — EMPTY on file:// pages, opaque origin), layout-shift
 *      (sources with element summaries + rect deltas), event timing.
 *   5. Runtime console errors/warnings + uncaught exceptions.
 * All recording state is restored in finally.
 */
import type { Protocol } from 'puppeteer-core'
import { z } from 'zod'
import type {
  ResolvedNode,
  ResolvedScriptPos,
  TimelineEvent,
  ToolContext,
  ToolDef,
} from '../types.js'
import { buildTimeline, renderTimeline, shortUrl } from '../engine/timeline.js'
import { pairAttributes, resolveTarget } from '../uid.js'

const OBJECT_GROUP = 'visionaire-record'

const DEFAULT_WAIT_MS = 1500
const MIN_WAIT_MS = 200
const MAX_WAIT_MS = 10_000
const DEFAULT_MAX_EVENTS = 40

const inputSchema = {
  uid: z.string().optional().describe('Element uid from a prior page_snapshot (e.g. "e5")'),
  selector: z.string().optional().describe('CSS selector — first match is used'),
  x: z.number().optional().describe('Viewport x coordinate (use with y)'),
  y: z.number().optional().describe('Viewport y coordinate (use with x)'),
  action: z
    .enum(['click', 'hover', 'manual'])
    .optional()
    .describe(
      'click/hover dispatch real input at the target; manual just records while a human interacts in the (headed) tab',
    ),
  waitMs: z
    .number()
    .optional()
    .describe(`Observation window after the action; default ${DEFAULT_WAIT_MS}, clamped ${MIN_WAIT_MS}–${MAX_WAIT_MS}`),
  maxEvents: z.number().optional().describe(`Hard cap on timeline lines; default ${DEFAULT_MAX_EVENTS}`),
}

const argsSchema = z.object(inputSchema)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

// ───────────────────────── page-side buffer ─────────────────────────

const INSTALL_BUFFER = `(() => {
  if (window.__visionaireTimeline) return true;
  const buf = { loaf: [], shifts: [], events: [], observers: [] };
  window.__visionaireTimeline = buf;
  const rect = (r) => (r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null);
  const observe = (opts, fn) => {
    try {
      const o = new PerformanceObserver((list) => { for (const e of list.getEntries()) fn(e); });
      o.observe(opts);
      buf.observers.push(o);
    } catch (err) { /* entry type unsupported — degrade silently */ }
  };
  observe({ type: 'long-animation-frame' }, (e) => {
    buf.loaf.push({
      startTime: e.startTime, duration: e.duration,
      scripts: (e.scripts || []).map((s) => ({
        sourceURL: s.sourceURL, sourceFunctionName: s.sourceFunctionName,
        sourceCharPosition: s.sourceCharPosition, invoker: s.invoker,
        startTime: s.startTime, duration: s.duration,
      })),
    });
  });
  observe({ type: 'layout-shift' }, (e) => {
    buf.shifts.push({
      startTime: e.startTime, value: e.value, hadRecentInput: e.hadRecentInput,
      sources: (e.sources || []).slice(0, 3).map((s) => {
        const n = s.node;
        let desc = null;
        if (n && n.nodeType === 1) {
          desc = n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') +
            (n.classList && n.classList.length ? '.' + Array.prototype.slice.call(n.classList, 0, 2).join('.') : '');
        } else if (n) { desc = n.nodeName; }
        return { node: desc, prev: rect(s.previousRect), cur: rect(s.currentRect) };
      }),
    });
  });
  observe({ type: 'event', durationThreshold: 16 }, (e) => {
    buf.events.push({ name: e.name, startTime: e.startTime, duration: e.duration });
  });
  return true;
})()`

/** Reads AND removes the buffer (observers disconnected) — used for teardown too. */
const READ_BUFFER = `(() => {
  const buf = window.__visionaireTimeline;
  if (!buf) return JSON.stringify(null);
  for (const o of buf.observers) { try { o.disconnect(); } catch (err) {} }
  delete window.__visionaireTimeline;
  return JSON.stringify({ loaf: buf.loaf, shifts: buf.shifts, events: buf.events });
})()`

interface PageRect {
  x: number
  y: number
  w: number
  h: number
}

interface PageBuffer {
  loaf: Array<{
    startTime: number
    duration: number
    scripts: Array<{
      sourceURL: string
      sourceFunctionName: string
      sourceCharPosition: number
      invoker: string
      startTime: number
      duration: number
    }>
  }>
  shifts: Array<{
    startTime: number
    value: number
    hadRecentInput: boolean
    sources: Array<{ node: string | null; prev: PageRect | null; cur: PageRect | null }>
  }>
  events: Array<{ name: string; startTime: number; duration: number }>
}

const EMPTY_BUFFER: PageBuffer = { loaf: [], shifts: [], events: [] }

// ───────────────────────── helpers ─────────────────────────

interface IndexedNode {
  nodeId: number
  backendNodeId: number
  tag: string
  attrs: Map<string, string>
}

function identityOf(info: IndexedNode | undefined): string {
  if (!info) return '<?>'
  const id = info.attrs.get('id')
  const classes = (info.attrs.get('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 2)
  return `<${info.tag}${id ? `#${id}` : ''}${classes.map((c) => `.${c}`).join('')}>`
}

function classDiff(oldValue: string, newValue: string): string {
  const before = new Set(oldValue.split(/\s+/).filter(Boolean))
  const after = new Set(newValue.split(/\s+/).filter(Boolean))
  const parts: string[] = []
  for (const c of after) if (!before.has(c)) parts.push(`+${c}`)
  for (const c of before) if (!after.has(c)) parts.push(`-${c}`)
  return parts.length > 0 ? `class ${parts.join(' ')}` : `class="${newValue}"`
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

function frameFunctionName(description: string | undefined): string | undefined {
  if (!description) return undefined
  const m = /^(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)/.exec(description)
  return m?.[1]
}

function shiftDelta(s: { node: string | null; prev: PageRect | null; cur: PageRect | null }): string {
  const name = s.node ?? 'a node'
  if (!s.prev || !s.cur) return `${name} shifted`
  const dx = Math.round(s.cur.x - s.prev.x)
  const dy = Math.round(s.cur.y - s.prev.y)
  const moves: string[] = []
  if (dx !== 0) moves.push(`${Math.abs(dx)}px ${dx < 0 ? 'left' : 'right'}`)
  if (dy !== 0) moves.push(`${Math.abs(dy)}px ${dy < 0 ? 'up' : 'down'}`)
  if (moves.length > 0) return `${name} moved ${moves.join(' and ')}`
  if (s.prev.w !== s.cur.w || s.prev.h !== s.cur.h) {
    return `${name} resized ${Math.round(s.prev.w)}x${Math.round(s.prev.h)} → ${Math.round(s.cur.w)}x${Math.round(s.cur.h)}`
  }
  return `${name} shifted in place`
}

// ───────────────────────── the tool ─────────────────────────

export const recordInteractionTool: ToolDef = {
  name: 'record_interaction',
  description:
    'Perform one interaction (click/hover at a target, or a manual window where the human acts in the ' +
    'headed tab) and record a source-attributed causal timeline: which handler ran, DOM/class/style ' +
    'mutations, transitions started or CANCELLED mid-flight, layout shifts with px deltas, slow-frame ' +
    'script attribution, console errors. The tool for "X is not smooth / does the wrong thing when I ' +
    'click Y". Target by uid, selector, or x+y.',
  inputSchema,
  async handler(ctx, args) {
    const a = argsSchema.parse(args)
    const action = a.action ?? 'click'
    const waitMs = clamp(Math.round(a.waitMs ?? DEFAULT_WAIT_MS), MIN_WAIT_MS, MAX_WAIT_MS)
    const maxEvents = clamp(Math.round(a.maxEvents ?? DEFAULT_MAX_EVENTS), 5, 200)

    const target = { uid: a.uid, selector: a.selector, x: a.x, y: a.y }
    const targetGiven =
      target.uid !== undefined || target.selector !== undefined || target.x !== undefined || target.y !== undefined
    let node: ResolvedNode | undefined
    if (action !== 'manual') {
      node = await resolveTarget(ctx, target) // throws helpfully when the target is missing
    } else if (targetGiven) {
      node = await resolveTarget(ctx, target)
    }

    const cdp = ctx.cdp
    const notes: string[] = []

    // ── raw buffers (recording stays lightweight: push + wall clock only) ──
    let seq = 0
    const attrEvents: Array<{ t: number; seq: number; nodeId: number; name: string; value: string }> = []
    const inlineStyleEvents: Array<{ t: number; seq: number; nodeIds: number[] }> = []
    const insertedEvents: Array<{ t: number; seq: number; parentNodeId: number; node: Protocol.DOM.Node }> = []
    const removedEvents: Array<{ t: number; seq: number; parentNodeId: number; nodeId: number }> = []
    const charDataEvents: Array<{ t: number; seq: number; nodeId: number; characterData: string }> = []
    const animCreated = new Map<string, number>()
    const animStarted: Array<{ t: number; seq: number; animation: Protocol.Animation.Animation }> = []
    const animCanceled: Array<{ t: number; seq: number; id: string }> = []
    const consoleEvents: Array<{ t: number; seq: number; level: string; text: string; frame?: Protocol.Runtime.CallFrame }> = []
    const exceptionEvents: Array<{ t: number; seq: number; text: string; frame?: Protocol.Runtime.CallFrame }> = []
    /** scriptId → url, self-maintained ONLY when ctx.scripts is absent (SPEC §14.1 wiring pending/optional). */
    const localScripts = new Map<string, string>()
    /** LoAF sourceURL → 1-based line for its sourceCharPosition (resolved pre-teardown, fallback mode only). */
    const loafLines = new Map<string, number>()

    const nodeIndex = new Map<number, IndexedNode>()
    const backendIndex = new Map<number, IndexedNode>()
    const indexNode = (n: Protocol.DOM.Node): void => {
      const info: IndexedNode = {
        nodeId: n.nodeId,
        backendNodeId: n.backendNodeId,
        tag: n.nodeName.toLowerCase(),
        attrs: pairAttributes(n.attributes),
      }
      nodeIndex.set(n.nodeId, info)
      backendIndex.set(n.backendNodeId, info)
      for (const c of n.children ?? []) indexNode(c)
      for (const s of n.shadowRoots ?? []) indexNode(s)
      if (n.contentDocument) indexNode(n.contentDocument)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const subs: Array<[string, (...evArgs: any[]) => void]> = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const on = (event: string, fn: (...evArgs: any[]) => void): void => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(cdp as any).on(event, fn)
      subs.push([event, fn])
    }

    const resolvePos = async (
      scriptId: string,
      line0: number,
      col0: number,
      functionName?: string,
    ): Promise<ResolvedScriptPos | undefined> => {
      if (ctx.scripts) {
        const pos = await ctx.scripts.resolvePosition(scriptId, line0, col0).catch(() => undefined)
        if (pos) return functionName ? { ...pos, functionName: pos.functionName ?? functionName } : pos
      }
      const url = localScripts.get(scriptId)
      if (!url) return undefined
      return { url, line: line0 + 1, column: col0 + 1, functionName }
    }

    const framePos = async (frame: Protocol.Runtime.CallFrame | undefined): Promise<ResolvedScriptPos | undefined> => {
      if (!frame) return undefined
      const fn = frame.functionName || undefined
      const resolved = await resolvePos(frame.scriptId, frame.lineNumber, frame.columnNumber, fn)
      if (resolved) return resolved
      if (!frame.url) return undefined
      return { url: frame.url, line: frame.lineNumber + 1, column: frame.columnNumber + 1, functionName: fn }
    }

    let debuggerEnabledHere = false
    let stackTracesEnabled = false
    let animationEnabled = false
    let runtimeEnabled = false
    let bufferInstalled = false

    let wallT0 = Date.now()
    let pageT0 = 0
    let handlerFrame: { scriptId: string; line: number; column: number; functionName?: string } | undefined
    let pageBuffer: PageBuffer = EMPTY_BUFFER
    let bufferLost = false
    let targetText: string | undefined
    const creationFrames = new Map<number, Protocol.Runtime.CallFrame>() // inserted nodeId → top creation frame

    try {
      // (1) Make every node known to the frontend BEFORE subscribing — CDP only
      // emits DOM mutation events for known nodes. Also index attributes for diffs.
      const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: true })
      indexNode(doc.root)

      if (!ctx.scripts) {
        on('Debugger.scriptParsed', (e: Protocol.Debugger.ScriptParsedEvent) => {
          if (e.url) localScripts.set(e.scriptId, e.url)
        })
        await cdp.send('Debugger.enable')
        debuggerEnabledHere = true
      }

      // Handler attribution + target geometry, before acting (getEventListeners
      // needs a Runtime objectId; the handler RemoteObject — with the function
      // name in its description — is only populated when an objectGroup is given).
      let center: { x: number; y: number } | undefined
      if (node) {
        const { object } = await cdp.send('DOM.resolveNode', {
          backendNodeId: node.backendNodeId,
          objectGroup: OBJECT_GROUP,
        })
        if (object.objectId) {
          if (action !== 'manual') {
            const eventType = action === 'click' ? 'click' : 'mouseover'
            const res = await cdp
              .send('DOMDebugger.getEventListeners', { objectId: object.objectId })
              .catch(() => ({ listeners: [] as Protocol.DOMDebugger.EventListener[] }))
            const listener = res.listeners.find((l) => l.type === eventType)
            if (listener) {
              handlerFrame = {
                scriptId: listener.scriptId,
                line: listener.lineNumber,
                column: listener.columnNumber,
                functionName: frameFunctionName(listener.handler?.description),
              }
            }
          }
          const geom = await cdp.send('Runtime.callFunctionOn', {
            objectId: object.objectId,
            functionDeclaration: `function () {
              this.scrollIntoView({ block: 'nearest' });
              const r = this.getBoundingClientRect();
              const t = ((this.innerText !== undefined ? this.innerText : this.textContent) || '')
                .replace(/\\s+/g, ' ').trim().slice(0, 30);
              return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, text: t });
            }`,
            returnByValue: true,
          })
          if (typeof geom.result.value === 'string') {
            const parsed = JSON.parse(geom.result.value) as { x: number; y: number; text: string }
            center = { x: Math.round(parsed.x), y: Math.round(parsed.y) }
            if (parsed.text) targetText = parsed.text
          }
        }
      }
      if (action !== 'manual' && !center) {
        throw new Error('target has no geometry (not rendered?) — cannot dispatch input at it')
      }

      // Channel 1: DOM mutations (buffer raw events + wall clock; resolve later).
      on('DOM.attributeModified', (e: Protocol.DOM.AttributeModifiedEvent) =>
        attrEvents.push({ t: Date.now(), seq: seq++, nodeId: e.nodeId, name: e.name, value: e.value }),
      )
      on('DOM.inlineStyleInvalidated', (e: Protocol.DOM.InlineStyleInvalidatedEvent) =>
        inlineStyleEvents.push({ t: Date.now(), seq: seq++, nodeIds: [...e.nodeIds] }),
      )
      on('DOM.childNodeInserted', (e: Protocol.DOM.ChildNodeInsertedEvent) =>
        insertedEvents.push({ t: Date.now(), seq: seq++, parentNodeId: e.parentNodeId, node: e.node }),
      )
      on('DOM.childNodeRemoved', (e: Protocol.DOM.ChildNodeRemovedEvent) =>
        removedEvents.push({ t: Date.now(), seq: seq++, parentNodeId: e.parentNodeId, nodeId: e.nodeId }),
      )
      on('DOM.characterDataModified', (e: Protocol.DOM.CharacterDataModifiedEvent) =>
        charDataEvents.push({ t: Date.now(), seq: seq++, nodeId: e.nodeId, characterData: e.characterData }),
      )

      // Channel 5: console errors/warnings + exceptions.
      on('Runtime.consoleAPICalled', (e: Protocol.Runtime.ConsoleAPICalledEvent) => {
        if (e.type !== 'error' && e.type !== 'warning' && e.type !== 'assert') return
        const text = e.args
          .map((arg) => (arg.value !== undefined ? String(arg.value) : (arg.description ?? arg.type)))
          .join(' ')
        consoleEvents.push({ t: Date.now(), seq: seq++, level: e.type, text, frame: e.stackTrace?.callFrames[0] })
      })
      on('Runtime.exceptionThrown', (e: Protocol.Runtime.ExceptionThrownEvent) => {
        const d = e.exceptionDetails
        const text = d.exception?.description?.split('\n')[0] ?? d.text
        exceptionEvents.push({ t: Date.now(), seq: seq++, text, frame: d.stackTrace?.callFrames[0] })
      })
      await cdp.send('Runtime.enable')
      runtimeEnabled = true

      // Channel 2: creation stacks for nodes inserted during the window.
      // (Protocol param is `enable`, not `enabled` — verified against Chrome.)
      await cdp.send('DOM.setNodeStackTracesEnabled', { enable: true })
      stackTracesEnabled = true

      // Channel 3: Animation domain.
      on('Animation.animationCreated', (e: Protocol.Animation.AnimationCreatedEvent) =>
        animCreated.set(e.id, Date.now()),
      )
      on('Animation.animationStarted', (e: Protocol.Animation.AnimationStartedEvent) =>
        animStarted.push({ t: Date.now(), seq: seq++, animation: e.animation }),
      )
      on('Animation.animationCanceled', (e: Protocol.Animation.AnimationCanceledEvent) =>
        animCanceled.push({ t: Date.now(), seq: seq++, id: e.id }),
      )
      await cdp.send('Animation.enable')
      animationEnabled = true

      // Channel 4: page-side PerformanceObserver buffer.
      await cdp.send('Runtime.evaluate', { expression: INSTALL_BUFFER, returnByValue: true })
      bufferInstalled = true

      // t0: wall clock and page performance.now() sampled in the same instant
      // (best effort — SPEC §14.4: CDP DOM events carry no timestamps).
      const before = Date.now()
      const t0res = await cdp.send('Runtime.evaluate', { expression: 'performance.now()', returnByValue: true })
      const after = Date.now()
      wallT0 = Math.round((before + after) / 2)
      pageT0 = typeof t0res.result.value === 'number' ? t0res.result.value : 0

      // ── the action ──
      if (action === 'manual') {
        notes.push(`manual mode: recorded ${waitMs}ms while the user interacted with the tab (pair with pick_element)`)
      } else if (center) {
        // Hover-before-click is REQUIRED: Chrome resolves the input target from
        // hover state (verified when building pick_element).
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: center.x, y: center.y })
        if (action === 'click') {
          await cdp.send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: center.x,
            y: center.y,
            button: 'left',
            clickCount: 1,
          })
          await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: center.x,
            y: center.y,
            button: 'left',
            clickCount: 1,
          })
        }
      }

      await sleep(waitMs)

      // ── collect (still inside try: these reads need the enabled domains) ──
      const bufRes = await cdp.send('Runtime.evaluate', { expression: READ_BUFFER, returnByValue: true })
      bufferInstalled = false // READ_BUFFER disconnects observers and deletes the buffer
      const parsed = typeof bufRes.result.value === 'string' ? (JSON.parse(bufRes.result.value) as PageBuffer | null) : null
      if (parsed) pageBuffer = parsed
      else bufferLost = true

      // Creation stacks, post-hoc (top frame only).
      for (const ins of insertedEvents) {
        try {
          const st = await cdp.send('DOM.getNodeStackTraces', { nodeId: ins.node.nodeId })
          const frame = st.creation?.callFrames[0]
          if (frame) creationFrames.set(ins.node.nodeId, frame)
        } catch {
          /* node gone again — no stack */
        }
      }

      // LoAF sourceCharPosition → 1-based line. LoAF only attributes same-origin
      // scripts, so an in-page fetch of the script text always may read it —
      // this works whether or not a ScriptRegistry owns the Debugger domain.
      {
        const bySource = new Map<string, number>()
        for (const frame of pageBuffer.loaf) {
          for (const s of frame.scripts) {
            if (s.sourceURL && !bySource.has(s.sourceURL)) bySource.set(s.sourceURL, s.sourceCharPosition)
          }
        }
        for (const [url, charPos] of bySource) {
          const lineRes = await cdp
            .send('Runtime.evaluate', {
              expression:
                `fetch(${JSON.stringify(url)}).then((r) => r.text())` +
                `.then((t) => t.slice(0, ${Math.max(0, Math.floor(charPos))}).split('\\n').length)` +
                `.catch(() => null)`,
              awaitPromise: true,
              returnByValue: true,
            })
            .catch(() => undefined)
          const line = lineRes?.result.value
          if (typeof line === 'number') loafLines.set(url, line)
          // else: CSP/network blocked the fetch — char position rendered instead
        }
      }
    } finally {
      for (const [event, fn] of subs) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(cdp as any).off(event, fn)
      }
      if (animationEnabled) await cdp.send('Animation.disable').catch(() => {})
      if (stackTracesEnabled) await cdp.send('DOM.setNodeStackTracesEnabled', { enable: false }).catch(() => {})
      if (bufferInstalled) {
        await cdp.send('Runtime.evaluate', { expression: READ_BUFFER, returnByValue: true }).catch(() => {})
      }
      if (runtimeEnabled) await cdp.send('Runtime.disable').catch(() => {})
      if (debuggerEnabledHere) await cdp.send('Debugger.disable').catch(() => {})
      await cdp.send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => {})
    }

    // ───────────── compose raw TimelineEvents (post-recording) ─────────────
    const relWall = (t: number): number => Math.max(0, t - wallT0)
    const relPage = (startTime: number): number => Math.max(0, startTime - pageT0)

    const uidFor = async (nodeId: number): Promise<{ uid?: string; info?: IndexedNode }> => {
      let info = nodeIndex.get(nodeId)
      if (!info) {
        try {
          const described = await cdp.send('DOM.describeNode', { nodeId })
          info = {
            nodeId,
            backendNodeId: described.node.backendNodeId,
            tag: described.node.nodeName.toLowerCase(),
            attrs: pairAttributes(described.node.attributes),
          }
          nodeIndex.set(nodeId, info)
          backendIndex.set(info.backendNodeId, info)
        } catch {
          return {}
        }
      }
      const uid = ctx.uids.assign(info.backendNodeId, {
        tag: info.tag,
        classes: (info.attrs.get('class') ?? '').split(/\s+/).filter(Boolean),
        attrId: info.attrs.get('id'),
      })
      return { uid, info }
    }

    interface Raw {
      seq: number
      ev: TimelineEvent
    }
    const raw: Raw[] = []

    // Action line (t=0). SPEC: "t=0  click → handler toggleSidebar @ js/sidebar.js:42".
    const actionNotes: string[] = []
    let handlerPos: ResolvedScriptPos | undefined
    if (handlerFrame) {
      handlerPos = await resolvePos(handlerFrame.scriptId, handlerFrame.line, handlerFrame.column, handlerFrame.functionName)
    } else if (node && action !== 'manual') {
      actionNotes.push(`no ${action === 'click' ? 'click' : 'mouseover'} listener directly on ${node.uid} — handler may be delegated to an ancestor; see get_listeners`)
    }
    const inputEntry = pageBuffer.events.find((e) => e.name === action && e.startTime >= pageT0 - 5)
    if (inputEntry && inputEntry.duration >= 100) {
      actionNotes.push(`input frame took ${Math.round(inputEntry.duration)}ms (event timing)`)
    }
    raw.push({
      seq: -1,
      ev: {
        tMs: 0,
        kind: 'action',
        uid: node?.uid,
        summary:
          action === 'manual'
            ? 'manual window opened — events below were performed live in the tab'
            : action,
        source: handlerPos,
        attributionNote: actionNotes.length > 0 ? actionNotes.join('; ') : undefined,
      },
    })

    // Insertions first: index their payload nodes so attr/text events on them resolve.
    for (const ins of insertedEvents) {
      const info: IndexedNode = {
        nodeId: ins.node.nodeId,
        backendNodeId: ins.node.backendNodeId,
        tag: ins.node.nodeName.toLowerCase(),
        attrs: pairAttributes(ins.node.attributes),
      }
      nodeIndex.set(info.nodeId, info)
      backendIndex.set(info.backendNodeId, info)
    }
    for (const ins of insertedEvents) {
      const info = nodeIndex.get(ins.node.nodeId)
      const childUid = ctx.uids.assign(ins.node.backendNodeId, {
        tag: info?.tag,
        classes: (info?.attrs.get('class') ?? '').split(/\s+/).filter(Boolean),
        attrId: info?.attrs.get('id'),
      })
      const parent = await uidFor(ins.parentNodeId)
      const source = await framePos(creationFrames.get(ins.node.nodeId))
      raw.push({
        seq: ins.seq,
        ev: {
          tMs: relWall(ins.t),
          kind: 'node-inserted',
          uid: parent.uid, // parent uid — coalesces as "+N similar node insertions under eX"
          summary: `${childUid} ${identityOf(info)} inserted under ${parent.uid ?? '?'} ${identityOf(parent.info)}`,
          source,
          attributionNote: source ? undefined : 'no creation stack recorded',
        },
      })
    }

    // Attribute changes, with class diffs against the pre-recording snapshot.
    const styleAttrSeen = new Set<number>()
    for (const ev of attrEvents) {
      const { uid, info } = await uidFor(ev.nodeId)
      const identity = identityOf(info) // BEFORE applying the change — "+collapsed" on the pre-change identity
      let change: string
      if (ev.name === 'class') {
        change = classDiff(info?.attrs.get('class') ?? '', ev.value)
      } else {
        change = `attribute ${ev.name}="${truncate(ev.value, 60)}"`
      }
      if (ev.name === 'style') styleAttrSeen.add(ev.nodeId)
      info?.attrs.set(ev.name, ev.value)
      raw.push({
        seq: ev.seq,
        ev: {
          tMs: relWall(ev.t),
          kind: 'attribute-change',
          uid,
          summary: `${uid ?? '?'} ${identity} ${change}`,
        },
      })
    }

    // Inline style invalidations (CSSOM writes — no attributeModified fires for
    // these; verified empirically). Final value read post-hoc, once per node.
    const inlineSeen = new Map<number, { t: number; seq: number; count: number }>()
    for (const ev of inlineStyleEvents) {
      for (const nodeId of ev.nodeIds) {
        if (styleAttrSeen.has(nodeId)) continue // already reported as a style attribute change
        const prev = inlineSeen.get(nodeId)
        if (prev) prev.count++
        else inlineSeen.set(nodeId, { t: ev.t, seq: ev.seq, count: 1 })
      }
    }
    for (const [nodeId, first] of inlineSeen) {
      const { uid, info } = await uidFor(nodeId)
      let finalStyle: string | undefined
      try {
        const res = await cdp.send('DOM.getAttributes', { nodeId })
        finalStyle = pairAttributes(res.attributes).get('style')
      } catch {
        /* node detached — value unavailable */
      }
      const valueText = finalStyle !== undefined ? ` → "${truncate(finalStyle, 60)}"` : ''
      const countText = first.count > 1 ? ` (${first.count} updates in window; final value shown)` : ''
      raw.push({
        seq: first.seq,
        ev: {
          tMs: relWall(first.t),
          kind: 'attribute-change',
          uid,
          summary: `${uid ?? '?'} ${identityOf(info)} inline style changed${valueText}${countText}`,
        },
      })
    }

    for (const ev of removedEvents) {
      const removedInfo = nodeIndex.get(ev.nodeId)
      const parent = await uidFor(ev.parentNodeId)
      raw.push({
        seq: ev.seq,
        ev: {
          tMs: relWall(ev.t),
          kind: 'node-removed',
          uid: parent.uid,
          summary: `${identityOf(removedInfo)} removed from ${parent.uid ?? '?'} ${identityOf(parent.info)}`,
        },
      })
    }

    for (const ev of charDataEvents) {
      const { uid } = await uidFor(ev.nodeId)
      raw.push({
        seq: ev.seq,
        ev: {
          tMs: relWall(ev.t),
          kind: 'text-change',
          uid,
          summary: `${uid ?? '?'} text → "${truncate(ev.characterData, 40)}"`,
        },
      })
    }

    // Animations. Empirical payload for CSSTransition: animation.name is the
    // transitioned PROPERTY; source carries backendNodeId/duration/delay/easing.
    const animById = new Map<string, { uid: string; property: string; word: string }>()
    for (const ev of animStarted) {
      const an = ev.animation
      const word = an.type === 'CSSTransition' ? 'transition' : 'animation'
      const property = an.name || (an.type === 'WebAnimation' ? 'web-animation' : '?')
      const backendId = an.source?.backendNodeId
      const info = backendId !== undefined ? backendIndex.get(backendId) : undefined
      const uid =
        backendId !== undefined
          ? ctx.uids.assign(backendId, {
              tag: info?.tag,
              classes: (info?.attrs.get('class') ?? '').split(/\s+/).filter(Boolean),
              attrId: info?.attrs.get('id'),
            })
          : '?'
      animById.set(an.id, { uid, property, word })
      const duration = an.source ? `${Math.round(an.source.duration)}ms` : ''
      const easing = an.source?.easing ?? ''
      const delay = an.source && an.source.delay > 0 ? ` delay ${Math.round(an.source.delay)}ms` : ''
      raw.push({
        seq: ev.seq,
        ev: {
          tMs: relWall(ev.t),
          kind: 'animation-started',
          uid: uid === '?' ? undefined : uid,
          summary: `${word} started on ${uid}: ${property} ${duration} ${easing}${delay}`.replace(/\s+/g, ' ').trimEnd(),
        },
      })
    }
    for (const ev of animCanceled) {
      const known = animById.get(ev.id)
      if (known) {
        raw.push({
          seq: ev.seq,
          ev: {
            tMs: relWall(ev.t),
            kind: 'animation-cancelled',
            uid: known.uid === '?' ? undefined : known.uid,
            // buildTimeline rewrites this into the ✗ CANCELLED verdict when the
            // matching started event is in the window.
            summary: `${known.word} cancelled on ${known.uid} (${known.property})`,
          },
        })
      } else if (animCreated.has(ev.id)) {
        raw.push({
          seq: ev.seq,
          ev: {
            tMs: relWall(ev.t),
            kind: 'animation-cancelled',
            summary:
              'a transition/animation was created and cancelled within a single style recalc — it never ' +
              'started (a synchronous style/display change killed it before its first frame; CDP carries ' +
              'no target for unstarted animations)',
          },
        })
      } else {
        raw.push({
          seq: ev.seq,
          ev: {
            tMs: relWall(ev.t),
            kind: 'animation-cancelled',
            summary: 'an animation running since before the recording was cancelled (target unknown)',
          },
        })
      }
    }

    // Layout shifts (page-side node summaries + rect deltas — SPEC §14.4).
    for (const [i, shift] of pageBuffer.shifts.entries()) {
      const parts = shift.sources.map(shiftDelta)
      raw.push({
        seq: 1_000_000_000 + i,
        ev: {
          tMs: relPage(shift.startTime),
          kind: 'layout-shift',
          summary: `layout shift ${shift.value.toFixed(2)} — ${parts.join(', ') || 'sources unavailable'}`,
        },
      })
    }

    for (const ev of consoleEvents) {
      raw.push({
        seq: ev.seq,
        ev: {
          tMs: relWall(ev.t),
          kind: 'console-error',
          summary: `console.${ev.level === 'warning' ? 'warn' : ev.level}: ${truncate(ev.text, 120)}`,
          source: await framePos(ev.frame),
        },
      })
    }
    for (const ev of exceptionEvents) {
      raw.push({
        seq: ev.seq,
        ev: {
          tMs: relWall(ev.t),
          kind: 'exception',
          summary: `uncaught exception: ${truncate(ev.text, 120)}`,
          source: await framePos(ev.frame),
        },
      })
    }

    // ── LoAF join: attribute mutations have no creation-stack equivalent. When
    // exactly ONE LoAF script overlaps the mutation's time window, name it. ──
    const loafScripts: Array<{ tStart: number; tEnd: number; label: string }> = []
    for (const frame of pageBuffer.loaf) {
      for (const s of frame.scripts) {
        if (!s.sourceURL) continue
        const line = loafLines.get(s.sourceURL)
        const fn = s.sourceFunctionName ? ` (${s.sourceFunctionName})` : ''
        const loc = line !== undefined ? `${shortUrl(s.sourceURL)}:${line}` : `${shortUrl(s.sourceURL)}@char${s.sourceCharPosition}`
        loafScripts.push({
          tStart: relPage(s.startTime),
          tEnd: relPage(s.startTime + s.duration),
          label: `${loc}${fn}`,
        })
      }
    }
    let plainMutationNoteUsed = false
    for (const { ev } of raw) {
      if (ev.kind !== 'attribute-change' || ev.source || ev.attributionNote) continue
      const t = ev.tMs ?? 0
      // Anchor on the script window's END: while a long frame's script runs,
      // the renderer main thread cannot flush CDP messages, so mutations caused
      // inside that frame are DELIVERED at/after its end (verified empirically:
      // a mutation made just before an 80ms busy-wait arrived ~5ms after the
      // LoAF script window closed). Mutations arriving well before the end
      // belong to an earlier, short (non-LoAF) frame — e.g. the click handler
      // itself. "likely" carries the remaining uncertainty.
      const overlapping = loafScripts.filter((s) => t >= s.tEnd - 25 && t <= s.tEnd + 120)
      const distinct = [...new Set(overlapping.map((s) => s.label))]
      if (distinct.length === 1) {
        ev.attributionNote = `mutation attribution unavailable; likely by ${distinct[0]} — only script running in that frame`
      } else if (!plainMutationNoteUsed) {
        ev.attributionNote = 'mutation attribution unavailable — creation stacks cover node insertions only'
        plainMutationNoteUsed = true
      }
    }

    // ── merge → coalesce → cap → render ──
    raw.sort((a, b) => a.seq - b.seq) // arrival order is the stable-sort tiebreak
    const rawEvents = raw.map((r) => r.ev)
    const timeline = buildTimeline(rawEvents, { maxEvents })
    const coalescedCount = timeline
      .filter((e) => e.kind === 'coalesced')
      .reduce((sum, e) => sum + (e.count ?? 0), 0)

    const entry = node ? ctx.uids.get(node.uid) : undefined
    const identity = node
      ? ` on ${node.uid} <${entry?.tag ?? '?'}${entry?.attrId ? `#${entry.attrId}` : ''}${(entry?.classes ?? [])
          .slice(0, 2)
          .map((c) => `.${c}`)
          .join('')}>${targetTextSuffix(targetText ?? entry?.textPreview)}`
      : ''
    const header =
      `interaction: ${action}${identity}  ` +
      `(recorded ${waitMs}ms, ${rawEvents.length} events${coalescedCount > 0 ? `, ${coalescedCount} coalesced` : ''})`

    if (bufferLost) {
      notes.push('page-side buffer lost (navigation during the window?) — layout shifts, slow-frame attribution and input timing are missing')
    }
    if (rawEvents.length <= 1) {
      notes.push(`no DOM/animation/shift events observed — nothing changed, or it happened after the ${waitMs}ms window (raise waitMs)`)
    }

    let text = renderTimeline(header, timeline)
    if (notes.length > 0) text += `\nnotes:\n${notes.map((n) => `  - ${n}`).join('\n')}`
    return { text }
  },
}

function targetTextSuffix(text: string | undefined): string {
  return text ? ` "${truncate(text, 30)}"` : ''
}
