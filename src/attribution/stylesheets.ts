/**
 * Stylesheet registry — SPEC §7.1. Listens to CSS.styleSheetAdded (CSS.enable,
 * called by the session AFTER attach(), replays already-existing sheets), stores
 * per-sheet metadata, and classifies sheets into StyleOrigins.
 */
import type { CDPSession, Protocol } from 'puppeteer-core'
import type { SheetInfo, StyleOrigin, StylesheetRegistryLike, WpSheetMeta } from '../types.js'
import { pairAttributes } from '../uid.js'
import { resolveWpOrigin, wpOriginToStyleOrigin } from './wordpress.js'

const MINIFIED_FILENAME = /\.min\./
// Heuristic for minified sheets without the .min. naming convention: a large
// payload packed into very few lines. header.length (chars) / (endLine + 1)
// approximates chars-per-line; hand-written CSS stays far below 200.
const MINIFIED_MIN_CHARS = 4096
const MINIFIED_CHARS_PER_LINE = 200

function looksMinified(sheet: SheetInfo): boolean {
  const path = sheet.sourceURL.split(/[?#]/)[0] ?? ''
  if (MINIFIED_FILENAME.test(path)) return true
  const lines = sheet.header.endLine + 1
  return sheet.header.length >= MINIFIED_MIN_CHARS && sheet.header.length / lines >= MINIFIED_CHARS_PER_LINE
}

/**
 * SPEC §5.2/§8.3: a minified sheet with no source map has untrustworthy line
 * numbers — degrade 'line' → 'file' and say so ("[file | … — minified, no map]").
 * With a source map present, sourcemaps.ts restores authored positions instead.
 */
function degradeMinified(origin: StyleOrigin, sheet: SheetInfo): StyleOrigin {
  if (origin.granularity !== 'line' || sheet.sourceMapURL || !looksMinified(sheet)) return origin
  return { ...origin, granularity: 'file', editSurface: 'minified, no map' }
}

export class StylesheetRegistry implements StylesheetRegistryLike {
  private sheets = new Map<string, SheetInfo>()
  /** styleSheetId → ownerNode backendNodeId still awaiting DOM.describeNode. */
  private pendingOwners = new Map<string, number>()
  private cdp: CDPSession | undefined

  /**
   * Must be called before the session enables CSS so the enable-time replay of
   * existing sheets is captured; tolerates CSS being already enabled (we just
   * listen — no CSS.enable here, that is the session's job).
   */
  async attach(cdp: CDPSession): Promise<void> {
    this.cdp = cdp
    cdp.on('CSS.styleSheetAdded', (ev: Protocol.CSS.StyleSheetAddedEvent) => {
      this.register(ev.header)
    })
    cdp.on('CSS.styleSheetRemoved', (ev: Protocol.CSS.StyleSheetRemovedEvent) => {
      this.sheets.delete(ev.styleSheetId)
      this.pendingOwners.delete(ev.styleSheetId)
    })
  }

  private register(header: Protocol.CSS.CSSStyleSheetHeader): void {
    const info: SheetInfo = {
      styleSheetId: header.styleSheetId,
      sourceURL: header.sourceURL,
      isInline: header.isInline,
      origin: header.origin,
      header,
    }
    if (header.sourceMapURL) info.sourceMapURL = header.sourceMapURL
    this.sheets.set(header.styleSheetId, info)
    if (header.ownerNode !== undefined) this.pendingOwners.set(header.styleSheetId, header.ownerNode)
  }

  /**
   * Resolve all pending owner-node id attributes (WP handles live there:
   * id="{handle}-css" / "{handle}-inline-css"). Tools call this once before
   * classifying; classify() itself stays synchronous on the cached values.
   */
  async ensureOwnerIds(): Promise<void> {
    if (!this.cdp || this.pendingOwners.size === 0) return
    const pending = [...this.pendingOwners.entries()]
    this.pendingOwners.clear()
    await Promise.all(
      pending.map(async ([styleSheetId, backendNodeId]) => {
        const sheet = this.sheets.get(styleSheetId)
        if (!sheet) return
        try {
          const res = await this.cdp!.send('DOM.describeNode', { backendNodeId })
          const id = pairAttributes(res.node.attributes).get('id')
          if (id !== undefined) sheet.ownerNodeAttrId = id
        } catch {
          // Owner node gone (removed <style>/<link>); classification degrades gracefully.
        }
      }),
    )
  }

  get(styleSheetId: string): SheetInfo | undefined {
    return this.sheets.get(styleSheetId)
  }

  all(): SheetInfo[] {
    return [...this.sheets.values()]
  }

  classify(sheet: SheetInfo, selector?: string): StyleOrigin {
    if (sheet.origin === 'user-agent') {
      // No file, no line, no edit surface — bottom of the honesty ladder by design.
      return { granularity: 'unknown', label: 'browser default (user agent)' }
    }
    if (sheet.origin === 'injected' || sheet.origin === 'inspector') {
      return { granularity: 'unknown', label: `${sheet.origin} stylesheet (not part of the page)` }
    }

    const meta: WpSheetMeta = { sourceURL: sheet.sourceURL, isInline: sheet.isInline }
    if (sheet.ownerNodeAttrId !== undefined) meta.ownerNodeAttrId = sheet.ownerNodeAttrId
    if (selector !== undefined) meta.selector = selector
    const wp = resolveWpOrigin(meta)
    if (wp) return degradeMinified(wpOriginToStyleOrigin(wp, meta), sheet)

    if (!sheet.sourceURL || sheet.header.isConstructed) {
      return { granularity: 'unknown', label: 'constructed stylesheet (CSS-in-JS production mode?)' }
    }
    if (sheet.isInline) {
      // sourceURL of an inline <style> sheet is the document URL.
      const label = sheet.ownerNodeAttrId ? `<inline style #${sheet.ownerNodeAttrId}>` : '<inline style>'
      return {
        granularity: 'line',
        label,
        file: sheet.sourceURL,
        editSurface: 'edit the <style> element in the document',
      }
    }
    if (/^(https?|file):/.test(sheet.sourceURL)) {
      // Label carries only what the location line doesn't: the serving host (CDN detection).
      let host = ''
      try {
        const u = new URL(sheet.sourceURL)
        if (u.protocol !== 'file:') host = u.host
      } catch {
        // unparseable — leave label empty, the location line shows the raw URL
      }
      return degradeMinified(
        {
          granularity: 'line',
          label: host,
          file: sheet.sourceURL,
          editSurface: 'edit this file',
        },
        sheet,
      )
    }
    // Odd scheme (blob:, chrome-extension:, …): file identity known, line not actionable.
    return { granularity: 'file', label: sheet.sourceURL, file: sheet.sourceURL }
  }

  clear(): void {
    this.sheets.clear()
    this.pendingOwners.clear()
  }
}
