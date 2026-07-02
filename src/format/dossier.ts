/**
 * Dossier renderers — SPEC §8.2 (what) and §8.3 (why). Plain text, compact,
 * no trailing whitespace. These strings are the product's face: keep formats stable.
 */
import type {
  AttributedDeclaration,
  BoxSummary,
  Bounds,
  ElementSummary,
  InactiveFinding,
  WhatDossierInput,
  WhyDossierInput,
} from '../types.js'

/**
 * Extra render inputs a tool may attach on top of the shared AttributedDeclaration.
 * Structurally assignable to AttributedDeclaration, so it flows through WhyDossierInput.
 */
export interface RenderableDeclaration extends AttributedDeclaration {
  /** Served sheet URL — location fallback when attribution provides no file. */
  sheetSourceURL?: string
  /** Ancestor identity for inherited candidates: "inherited from e12 <div.card>". */
  inheritedFrom?: { uid?: string; tag?: string; classes?: string[]; attrId?: string }
}

// ───────────────────────── why-dossier (§8.3) ─────────────────────────

export function renderWhyDossier(input: WhyDossierInput): string {
  const lines: string[] = [headerLine(input.element)]

  // Only supplied when the element is not visible — lead with that, it changes everything.
  if (input.visibility && !input.visibility.visible) {
    lines.push(`visibility: ${input.visibility.status}${input.visibility.cause ? ` — ${input.visibility.cause}` : ''}`)
  }

  for (const v of input.verdicts) {
    const value = v.computedValue || v.winner?.value || '(unset)'
    lines.push(`why ${v.property} = ${value}:`)
    if (v.winner) {
      lines.push(`  WINNER  ${declHead(v.winner as RenderableDeclaration, true)}`)
      const loc = locationLine(v.winner as RenderableDeclaration)
      if (loc) lines.push(`    ${loc}`)
    } else {
      lines.push('  no authored declaration — value comes from browser defaults or inheritance')
    }
    for (const { decl, reason } of v.losers) {
      lines.push(`  lost (${reason})  ${declHead(decl as RenderableDeclaration, false)}`)
      const loc = locationLine(decl as RenderableDeclaration)
      if (loc) lines.push(`    ${loc}`)
    }
  }

  if (input.truncatedProperties) {
    lines.push(`[${input.truncatedProperties} more properties — ask with property:]`)
  }

  const notes: string[] = []
  for (const f of input.inactive ?? []) notes.push(inactiveLine(f))
  for (const n of input.notes ?? []) notes.push(n)
  if (notes.length) {
    lines.push('notes:')
    for (const n of notes) lines.push(`  - ${n}`)
  }

  return lines.join('\n')
}

/** One declaration head line: selector { prop: value } spec(a,b,c) — variants per origin type. */
function declHead(d: RenderableDeclaration, isWinner: boolean): string {
  const imp = d.important ? ' !important' : ''
  const body = `{ ${d.property}: ${d.value}${imp} }`
  // Non-obvious value provenance: an expanded shorthand shows its source shorthand.
  const from = d.fromShorthand && d.fromShorthand !== d.property ? ` (from ${d.fromShorthand})` : ''

  switch (d.originType) {
    case 'inline':
      // Winner value already appears on the "why prop = value:" line.
      return isWinner ? 'inline style attribute' : `inline style attribute ${body}`
    case 'attribute':
      return isWinner ? 'element attribute style' : `element attribute style ${body}`
    case 'inherited':
    case 'inherited-inline': {
      // spec() omitted for inherited candidates — SPEC §8.3.
      const head = d.originType === 'inherited-inline' ? 'inline style attribute' : (d.selector ?? '(style)')
      return `${head} ${body}${from}  ${inheritedLabel(d)}`
    }
    default: {
      const spec = d.specificity ? `  spec(${d.specificity.a},${d.specificity.b},${d.specificity.c})` : ''
      return `${d.selector ?? '(anonymous rule)'} ${body}${from}${spec}`
    }
  }
}

function inheritedLabel(d: RenderableDeclaration): string {
  const src = d.inheritedFrom
  if (!src?.uid) return 'inherited from ancestor'
  if (!src.tag) return `inherited from ${src.uid}`
  return `inherited from ${src.uid} ${tagLabel(src.tag, src.classes ?? [], src.attrId)}`
}

/** "→ location  [granularity | label — edit hint]" — either half may be absent. */
function locationLine(d: RenderableDeclaration): string | undefined {
  const loc = renderLocation(d)
  const bracket = renderBracket(d)
  if (!loc && !bracket) return undefined
  if (!loc) return `→ ${bracket}`
  if (!bracket) return `→ ${loc}`
  return `→ ${loc}  ${bracket}`
}

/** Location preference: authored (source map) > origin.file:line > trimmed sheet URL > <inline>. */
function renderLocation(d: RenderableDeclaration): string | undefined {
  if (d.authored) return `${d.authored.file}:${d.authored.line} (via source map)`
  // CDP ranges are 0-based; rendered locations are 1-based. StyleOrigin.line is already 1-based.
  const rangeLine = d.range ? d.range.startLine + 1 : undefined
  if (d.origin?.file) {
    // 'file' granularity means the line is unreliable (minified, no map) — don't print one.
    const line = d.origin.line ?? (d.origin.granularity === 'line' ? rangeLine : undefined)
    // Absolute URLs get trimmed for readability; attribution-produced relative paths pass through.
    const file = /:\/\//.test(d.origin.file) ? trimUrl(d.origin.file) : d.origin.file
    return file + (line !== undefined ? `:${line}` : '')
  }
  if (d.sheetSourceURL) return trimUrl(d.sheetSourceURL) + (rangeLine !== undefined ? `:${rangeLine}` : '')
  if (d.originType === 'user-agent') return 'user-agent stylesheet'
  if (d.originType === 'matched' || d.originType === 'inherited' || d.originType === 'injected') return '<inline>'
  return undefined
}

function renderBracket(d: RenderableDeclaration): string | undefined {
  const o = d.origin
  if (!o) {
    // Honesty ladder (SPEC §9): an unattributed sheet-backed rule still gets a label.
    if (d.styleSheetId && d.originType !== 'inline' && d.originType !== 'attribute') return '[unknown]'
    return undefined
  }
  const label = o.label ? ` | ${o.label}` : ''
  return `[${o.granularity}${label}${o.editSurface ? ` — ${o.editSurface}` : ''}]`
}

function inactiveLine(f: InactiveFinding): string {
  const d = f.decl as RenderableDeclaration
  const loc = shortLoc(d)
  return `'${d.property}: ${d.value}'${loc ? ` at ${loc}` : ''} is INACTIVE — ${f.reason}${f.fixHint ? `; ${f.fixHint}` : ''}`
}

/** Compact single-segment location for notes, e.g. "style.css:106". */
function shortLoc(d: RenderableDeclaration): string | undefined {
  if (d.authored) return `${lastSegment(d.authored.file)}:${d.authored.line}`
  const line = d.origin?.line ?? (d.range ? d.range.startLine + 1 : undefined)
  const file = d.origin?.file ?? d.sheetSourceURL
  if (!file) return undefined
  return lastSegment(file) + (line !== undefined ? `:${line}` : '')
}

// ───────────────────────── what-dossier (§8.2) ─────────────────────────

export function renderWhatDossier(input: WhatDossierInput): string {
  const lines: string[] = []
  const visTag = input.visibility.visible ? 'visible' : input.visibility.status
  lines.push(`${headerLine(input.element)}  — ${visTag}`)

  if (input.box) lines.push(boxLine(input.box))
  if (input.layout) lines.push(`layout: ${input.layout}`)

  if (input.computed.length) {
    lines.push('computed (authored-relevant):')
    for (const l of packPairs(input.computed)) lines.push(`  ${l}`)
  }

  lines.push(`visibility: ${input.visibility.status}${input.visibility.cause ? ` — ${input.visibility.cause}` : ''}`)

  if (input.notes?.length) {
    lines.push('notes:')
    for (const n of input.notes) lines.push(`  - ${n}`)
  }
  return lines.join('\n')
}

function boxLine(b: BoxSummary): string {
  return (
    `box: content ${fmtNum(b.content.width)}x${fmtNum(b.content.height)} @(${fmtNum(b.content.x)},${fmtNum(b.content.y)})` +
    ` | padding ${edges(b.padding)} | border ${edges(b.border)} | margin ${edges(b.margin)}`
  )
}

/** Pack "prop: value" pairs several per line, ' | '-joined, wrapping near 92 chars. */
function packPairs(pairs: WhatDossierInput['computed']): string[] {
  const parts = pairs.map((p) => `${p.property}: ${p.value}${p.usedValue ? ` → ${p.usedValue}` : ''}`)
  const lines: string[] = []
  let current = ''
  for (const part of parts) {
    if (!current) current = part
    else if (current.length + 3 + part.length <= 92) current += ` | ${part}`
    else {
      lines.push(current)
      current = part
    }
  }
  if (current) lines.push(current)
  return lines
}

// ───────────────────────── shared helpers ─────────────────────────

function headerLine(el: ElementSummary): string {
  const text = el.text?.trim() ? ` "${truncate(el.text.trim(), 40)}"` : ''
  return `element ${el.uid} ${tagLabel(el.tag, el.classes, el.attrId)}${text}`
}

function tagLabel(tag: string, classes: string[], attrId?: string): string {
  const id = attrId ? `#${attrId}` : ''
  const cls = classes.length ? `.${classes.slice(0, 3).join('.')}` : ''
  return `<${tag}${id}${cls}>`
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** Trim a sheet URL to its last 3 path segments — SPEC §8.3 location fallback. */
function trimUrl(url: string): string {
  let path = url
  try {
    path = new URL(url).pathname
  } catch {
    // not a parseable URL — trim the raw string
  }
  const segs = path.split('/').filter(Boolean)
  if (!segs.length) return url
  const tail = segs.slice(-3).join('/')
  return segs.length > 3 ? `…/${tail}` : tail
}

function lastSegment(file: string): string {
  const segs = file.split('/').filter(Boolean)
  return segs[segs.length - 1] ?? file
}

function fmtNum(n: number): string {
  const r = Math.round(n * 10) / 10
  return Number.isInteger(r) ? String(r) : r.toFixed(1)
}

function edges(e: [number, number, number, number]): string {
  const [t, r, b, l] = e.map(fmtNum) as [string, string, string, string]
  return t === r && r === b && b === l ? t : `${t} ${r} ${b} ${l}`
}

/** Re-exported for renderers/tools that format Bounds consistently. */
export function formatBounds(b: Bounds): string {
  return `${fmtNum(b.width)}x${fmtNum(b.height)} @(${fmtNum(b.x)},${fmtNum(b.y)})`
}
