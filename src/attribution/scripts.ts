/**
 * Script registry — SPEC §14.1: the JS mirror of the StylesheetRegistry.
 * Listens to Debugger.scriptParsed; the session enables Debugger AFTER attach()
 * because Debugger.enable replays every already-parsed script (verified
 * empirically; a disable/enable toggle re-emits live scripts with the SAME
 * scriptIds, so the post-navigation resync converges regardless of event
 * order — scriptIds are never reused within a browser process).
 * resolvePosition turns 0-based CDP positions into 1-based human positions,
 * with JS source-map resolution (same @jridgewell/trace-mapping + cache
 * pattern as sourcemaps.ts) and the WordPress origin lens shared with CSS:
 * a handler in /wp-content/plugins/some-slider/… is labeled
 * "plugin: some-slider" — label only, no edit surface.
 */
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { CDPSession, Protocol } from 'puppeteer-core'
import type { AuthoredPos, ResolvedScriptPos, ScriptInfo, ScriptRegistryLike, WpSheetMeta } from '../types.js'
import { resolveWpOrigin, wpOriginToStyleOrigin } from './wordpress.js'

const FETCH_TIMEOUT_MS = 3000

/** scriptId → decoded map; null = load already failed (do not refetch per frame). */
const mapCache = new Map<string, TraceMap | null>()

export class ScriptRegistry implements ScriptRegistryLike {
  private scripts = new Map<string, ScriptInfo>()

  /**
   * Must be called before the session enables Debugger so the enable-time
   * replay of already-parsed scripts is captured; tolerates Debugger being
   * already enabled (we just listen — Debugger.enable is the session's job).
   */
  async attach(cdp: CDPSession): Promise<void> {
    cdp.on('Debugger.scriptParsed', (ev: Protocol.Debugger.ScriptParsedEvent) => {
      this.register(ev)
    })
  }

  private register(ev: Protocol.Debugger.ScriptParsedEvent): void {
    const info: ScriptInfo = { scriptId: ev.scriptId, url: ev.url }
    // CDP sends empty strings, not undefined, when these are absent.
    if (ev.sourceMapURL) info.sourceMapURL = ev.sourceMapURL
    if (ev.embedderName) info.embedderName = ev.embedderName
    this.scripts.set(ev.scriptId, info)
  }

  get(scriptId: string): ScriptInfo | undefined {
    return this.scripts.get(scriptId)
  }

  /**
   * @param line 0-based line (CDP Debugger/Runtime call-frame convention)
   * @param column 0-based column
   * @returns 1-based served position; `authored` (when a source map resolves)
   *   follows the source-map convention of AuthoredPos: 1-based line, 0-based
   *   column. Unknown scriptId → undefined; map failure → position, unmapped.
   */
  async resolvePosition(scriptId: string, line: number, column: number): Promise<ResolvedScriptPos | undefined> {
    const script = this.scripts.get(scriptId)
    if (!script) return undefined
    const pos: ResolvedScriptPos = { url: script.url, line: line + 1, column: column + 1 }
    const label = wpOriginLabel(script.url)
    if (label !== undefined) pos.originLabel = label
    const authored = await resolveAuthoredJsPosition(script, line, column)
    if (authored) pos.authored = authored
    return pos
  }

  clear(): void {
    // scriptIds restart in a fresh browser process; evict our ids so a later
    // session cannot hit a stale cached map under a recycled id.
    for (const id of this.scripts.keys()) mapCache.delete(id)
    this.scripts.clear()
  }
}

const DELEGATION_FRAMEWORKS: ReadonlyArray<{ pattern: RegExp; name: string }> = [
  { pattern: /react-dom/, name: 'react-dom' },
  { pattern: /jquery/, name: 'jquery' },
  { pattern: /vue\.runtime|vue\.global/, name: 'vue' },
]

/**
 * SPEC §14.2 delegation honesty rule: when a handler's script URL belongs to a
 * known delegation framework, the listener is labeled a delegated root
 * listener instead of pretending to be the component handler.
 */
export function classifyDelegation(url: string): string | undefined {
  const path = urlPathname(url).toLowerCase()
  return DELEGATION_FRAMEWORKS.find((f) => f.pattern.test(path))?.name
}

/** The CSS attribution synergy, for free: theme/plugin URLs classify identically for JS. */
function wpOriginLabel(url: string): string | undefined {
  if (!url) return undefined
  const meta: WpSheetMeta = { sourceURL: url, isInline: false }
  const wp = resolveWpOrigin(meta)
  return wp ? wpOriginToStyleOrigin(wp, meta).label : undefined
}

function urlPathname(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url.split(/[?#]/)[0] ?? url
  }
}

// ───────────── source-map hop (mirrors sourcemaps.ts; any failure → unmapped) ─────────────

async function resolveAuthoredJsPosition(
  script: ScriptInfo,
  line: number,
  column: number,
): Promise<AuthoredPos | undefined> {
  if (!script.sourceMapURL) return undefined
  let traced = mapCache.get(script.scriptId)
  if (traced === undefined) {
    traced = await loadTraceMap(script.sourceMapURL, script.url || script.embedderName || '')
    mapCache.set(script.scriptId, traced)
  }
  if (!traced) return undefined
  try {
    // CDP positions are 0-based; originalPositionFor wants 1-based line, 0-based column.
    const pos = originalPositionFor(traced, { line: line + 1, column })
    if (pos.line === null || pos.source === null) return undefined
    return { file: pos.source, line: pos.line, column: pos.column }
  } catch {
    return undefined
  }
}

async function loadTraceMap(sourceMapURL: string, scriptURL: string): Promise<TraceMap | null> {
  try {
    if (sourceMapURL.startsWith('data:')) {
      const json = decodeDataUrl(sourceMapURL)
      return json === undefined ? null : new TraceMap(json)
    }
    const resolved = resolveMapUrl(sourceMapURL, scriptURL)
    if (!resolved) return null
    const text = await fetchText(resolved)
    if (text === undefined) return null
    // Some servers prepend an XSSI guard; strip it like DevTools does.
    const clean = text.replace(/^\)\]\}'[^\n]*\n?/, '')
    // Passing the map URL makes originalPositionFor return resolved source URLs.
    return new TraceMap(clean, resolved)
  } catch {
    return null
  }
}

function decodeDataUrl(url: string): string | undefined {
  const comma = url.indexOf(',')
  if (comma < 0) return undefined
  const params = url.slice('data:'.length, comma).split(';')
  const data = url.slice(comma + 1)
  try {
    return params.includes('base64')
      ? Buffer.from(data, 'base64').toString('utf8')
      : decodeURIComponent(data)
  } catch {
    return undefined
  }
}

function resolveMapUrl(mapUrl: string, baseUrl: string): string | undefined {
  try {
    return new URL(mapUrl, baseUrl || undefined).href
  } catch {
    return undefined
  }
}

async function fetchText(url: string): Promise<string | undefined> {
  const parsed = new URL(url)
  // Node's fetch rejects file: URLs — needed for local fixtures, so read directly.
  if (parsed.protocol === 'file:') return readFile(fileURLToPath(parsed), 'utf8')
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) return undefined
  return res.text()
}
