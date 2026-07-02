/**
 * Source-map hop of the attribution join — SPEC §7.2 hop 3.
 * Any failure (bad URL, timeout, non-JSON, no mapping) → undefined; the caller
 * falls back to the served file at granularity 'file'.
 */
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { AuthoredPos, SheetInfo } from '../types.js'

const FETCH_TIMEOUT_MS = 3000

/** styleSheetId → decoded map; null = load already failed (do not refetch per declaration). */
const mapCache = new Map<string, TraceMap | null>()

/**
 * @param line 0-based line in the served sheet (CDP SourceRange convention)
 * @param column 0-based column (CDP SourceRange convention)
 * @returns authored position with 1-based line, 0-based column (source-map convention)
 */
export async function resolveAuthoredPosition(
  sheet: SheetInfo,
  line: number,
  column: number,
): Promise<AuthoredPos | undefined> {
  if (!sheet.sourceMapURL) return undefined
  let traced = mapCache.get(sheet.styleSheetId)
  if (traced === undefined) {
    traced = await loadTraceMap(sheet.sourceMapURL, sheet.sourceURL)
    mapCache.set(sheet.styleSheetId, traced)
  }
  if (!traced) return undefined
  try {
    // CDP ranges are 0-based; originalPositionFor wants 1-based line, 0-based column.
    const pos = originalPositionFor(traced, { line: line + 1, column })
    if (pos.line === null || pos.source === null) return undefined
    return { file: pos.source, line: pos.line, column: pos.column }
  } catch {
    return undefined
  }
}

export function clearSourceMapCache(): void {
  mapCache.clear()
}

async function loadTraceMap(sourceMapURL: string, sheetURL: string): Promise<TraceMap | null> {
  try {
    if (sourceMapURL.startsWith('data:')) {
      const json = decodeDataUrl(sourceMapURL)
      return json === undefined ? null : new TraceMap(json)
    }
    const resolved = resolveMapUrl(sourceMapURL, sheetURL)
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
