/**
 * page_origins — SPEC §4 #5. Stylesheet inventory (classified via the sheet
 * registry) plus platform detection from document markers. Rule counts are
 * deliberately omitted: CSSStyleSheetHeader carries no rule count and fetching
 * every sheet's text (CSS.getStyleSheetText) is too heavy — bytes only.
 */
import { z } from 'zod'
import { estimateTokens } from '../types.js'
import type { PlatformInfo, SheetInfo, ToolDef } from '../types.js'
import { detectPlatform } from '../attribution/wordpress.js'

const BUDGET_TOKENS = 1800

const inputSchema = {} satisfies Record<string, z.ZodTypeAny>

const MARKERS_EXPR = `(() => ({
  generator: Array.from(document.querySelectorAll('meta[name="generator" i]'))
    .map((m) => m.getAttribute('content') || '').filter(Boolean).join(' | ') || undefined,
  bodyClasses: document.body ? Array.from(document.body.classList) : [],
}))()`

/** header.length is characters, ≈ bytes for ASCII CSS. */
function kb(chars: number): string {
  const k = chars / 1024
  return k >= 100 ? `${Math.round(k)} KB` : `${k.toFixed(1)} KB`
}

function renderPlatform(p: PlatformInfo): string {
  if (p.platform !== 'wordpress') {
    return 'platform: not WordPress (no /wp-content/, /wp-includes/, or generator markers)'
  }
  const parts = [`platform: WordPress${p.version ? ` ${p.version}` : ''}`]
  parts.push(p.theme ? `theme: ${p.theme}${p.childTheme ? ` (child: ${p.childTheme})` : ''}` : 'theme: unknown')
  parts.push(`builders: ${p.builders.length > 0 ? p.builders.join(', ') : 'none detected'}`)
  parts.push(`optimizers: ${p.optimizers.length > 0 ? p.optimizers.join(', ') : 'none detected'}`)
  return parts.join(' | ')
}

export const pageOriginsTool: ToolDef = {
  name: 'page_origins',
  description:
    'Inventory every stylesheet on the page (name, byte size, origin classification, source-map presence) and detect the platform: WordPress version, theme, builders, optimizers.',
  inputSchema,
  handler: async (ctx, args) => {
    z.object(inputSchema).parse(args)

    // Owner-node id attributes carry WP handles; resolve them before classifying
    // (feature-detected: the interface does not promise ensureOwnerIds).
    const reg = ctx.sheets as typeof ctx.sheets & { ensureOwnerIds?: () => Promise<void> }
    if ('ensureOwnerIds' in reg && typeof reg.ensureOwnerIds === 'function') {
      await reg.ensureOwnerIds()
    }

    const sheets = ctx.sheets.all()

    const markersRes = await ctx.cdp.send('Runtime.evaluate', {
      expression: MARKERS_EXPR,
      returnByValue: true,
    })
    const markers = (markersRes.result.value ?? {}) as { generator?: string; bodyClasses?: string[] }
    const platform = detectPlatform(sheets, markers)

    const files: SheetInfo[] = []
    const inline: SheetInfo[] = []
    let userAgent = 0
    let constructed = 0
    let injected = 0
    for (const s of sheets) {
      if (s.origin === 'user-agent') userAgent++
      else if (s.origin === 'injected' || s.origin === 'inspector') injected++
      else if (s.header.isConstructed || (!s.sourceURL && !s.isInline)) constructed++
      else if (s.isInline) inline.push(s)
      else files.push(s)
    }
    files.sort((a, b) => b.header.length - a.header.length)
    inline.sort((a, b) => b.header.length - a.header.length)

    const fileLines = files.map((s) => {
      const origin = ctx.sheets.classify(s)
      const name = origin.file ?? s.sourceURL
      const tag = origin.label === name ? `[${origin.granularity}]` : `[${origin.granularity} | ${origin.label}]`
      return `${name} — ${kb(s.header.length)} ${tag}${s.sourceMapURL ? ' (source map)' : ''}`
    })

    // Unnamed inline <style> sheets are indistinguishable; collapse them to one line.
    const inlineLines: string[] = []
    let anonCount = 0
    let anonChars = 0
    for (const s of inline) {
      if (s.ownerNodeAttrId) {
        const origin = ctx.sheets.classify(s)
        inlineLines.push(`<style#${s.ownerNodeAttrId}> — ${kb(s.header.length)} [${origin.granularity} | ${origin.label}]`)
      } else {
        anonCount++
        anonChars += s.header.length
      }
    }
    if (anonCount === 1) inlineLines.push(`<style> — ${kb(anonChars)} [line | inline <style>]`)
    else if (anonCount > 1) inlineLines.push(`<style> ×${anonCount} — ${kb(anonChars)} total [line | inline <style> elements]`)

    const tailParts: string[] = []
    if (userAgent > 0) tailParts.push(`${userAgent} user-agent`)
    if (constructed > 0) tailParts.push(`${constructed} constructed`)
    if (injected > 0) tailParts.push(`${injected} injected/inspector`)
    const tail = tailParts.length > 0 ? `plus ${tailParts.join(', ')} sheet(s) — not editable page files` : undefined

    const header = `stylesheets on ${ctx.page.url()}: ${sheets.length} total (${files.length} files, ${inline.length} inline, ${userAgent + constructed + injected} user-agent/constructed)`

    let shownFiles = fileLines.length
    const compose = (): string => {
      const parts = [header, ...fileLines.slice(0, shownFiles)]
      if (shownFiles < fileLines.length) {
        parts.push(`[${fileLines.length - shownFiles} more file stylesheets omitted for budget — smallest last]`)
      }
      parts.push(...inlineLines)
      if (tail) parts.push(tail)
      parts.push('', renderPlatform(platform))
      return parts.join('\n')
    }
    let text = compose()
    while (estimateTokens(text) > BUDGET_TOKENS && shownFiles > 1) {
      shownFiles--
      text = compose()
    }
    return { text }
  },
}
