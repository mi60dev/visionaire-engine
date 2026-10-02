/**
 * Map a CSSOM rule path (indexes through sheet.cssRules → grouping rule
 * cssRules → …) back to a line in the stylesheet's source text. CSSOM carries
 * no source positions, so the lite (Firefox) backend recovers them by walking
 * the source's rule structure in the same order the parser does. The prelude
 * is compared with the CSSOM selector so a desync (a rule the parser dropped)
 * is reported as approximate rather than silently wrong.
 */

interface RuleNode {
  start: number
  prelude: string
  children: RuleNode[]
  /** Offset just past the opening brace of a declaration block. */
  bodyStart?: number
  bodyEnd?: number
}

/** At-rules whose block holds rules (CSSOM grouping rules) rather than declarations. */
const GROUPING = /^@(media|supports|layer|container|document|-moz-document|scope|starting-style)\b/i

export function parseRuleTree(text: string): RuleNode {
  const root: RuleNode = { start: 0, prelude: '', children: [] }
  const stack: RuleNode[] = []
  let cur = root
  let stmtStart = -1
  let i = 0
  const n = text.length

  const skipCommentOrString = (): boolean => {
    const ch = text[i]
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? n : end + 2
      return true
    }
    if (ch === '"' || ch === "'") {
      i++
      while (i < n && text[i] !== ch) i += text[i] === '\\' ? 2 : 1
      i++
      return true
    }
    return false
  }

  /** Skip a declaration block (and anything nested in it) up to and including its closing brace. */
  const skipBlock = (): void => {
    let depth = 1
    while (i < n && depth > 0) {
      if (skipCommentOrString()) continue
      if (text[i] === '{') depth++
      else if (text[i] === '}') depth--
      i++
    }
  }

  while (i < n) {
    if (skipCommentOrString()) continue
    const ch = text[i]!
    if (stmtStart < 0 && !/\s/.test(ch) && ch !== '}' && ch !== ';') stmtStart = i
    if (ch === '{') {
      const prelude = text.slice(stmtStart < 0 ? i : stmtStart, i).trim()
      const node: RuleNode = { start: stmtStart < 0 ? i : stmtStart, prelude, children: [] }
      cur.children.push(node)
      stmtStart = -1
      i++
      if (GROUPING.test(prelude)) {
        stack.push(cur)
        cur = node
      } else {
        node.bodyStart = i
        skipBlock()
        node.bodyEnd = i - 1
      }
      continue
    }
    if (ch === ';') {
      if (stmtStart >= 0) {
        const prelude = text.slice(stmtStart, i).trim()
        // @charset never appears in cssRules.
        if (!/^@charset\b/i.test(prelude)) cur.children.push({ start: stmtStart, prelude, children: [] })
      }
      stmtStart = -1
      i++
      continue
    }
    if (ch === '}') {
      cur = stack.pop() ?? root
      stmtStart = -1
    }
    i++
  }
  return root
}

const norm = (s: string): string =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s*([,>+~(){}])\s*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

export interface AuthoredDeclaration {
  value: string
  important: boolean
  /** 1-based line of the declaration itself. */
  line: number
}

export interface RuleLocation {
  /** 1-based */
  line: number
  /** 1-based */
  column: number
  /** False when the source prelude does not match the CSSOM selector — line is a best guess. */
  exact: boolean
  /** Declarations as written in the source (CSSOM re-serializes values, e.g. #fff → rgb(255, 255, 255)). */
  declarations: Map<string, AuthoredDeclaration>
}

/** Split a declaration block into authored `name: value` pairs with their lines. */
export function parseDeclarations(text: string, start: number, end: number): Map<string, AuthoredDeclaration> {
  const out = new Map<string, AuthoredDeclaration>()
  let i = start
  let declStart = start
  let depth = 0
  const flush = (to: number): void => {
    const raw = text.slice(declStart, to)
    const colon = raw.indexOf(':')
    if (colon > 0) {
      const name = raw.slice(0, colon).replace(/\/\*[\s\S]*?\*\//g, '').trim().toLowerCase()
      let value = raw.slice(colon + 1).replace(/\/\*[\s\S]*?\*\//g, '').trim()
      const important = /!\s*important\s*$/i.test(value)
      if (important) value = value.replace(/\s*!\s*important\s*$/i, '')
      const lead = raw.length - raw.trimStart().length
      if (/^(--)?[a-z-]+$/.test(name)) out.set(name, { value, important, line: text.slice(0, declStart + lead).split('\n').length })
    }
  }
  while (i < end) {
    const ch = text[i]
    if (ch === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2)
      i = e < 0 ? end : e + 2
      continue
    }
    if (ch === '"' || ch === "'") {
      i++
      while (i < end && text[i] !== ch) i += text[i] === '\\' ? 2 : 1
      i++
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ';' && depth === 0) {
      flush(i)
      declStart = i + 1
    } else if (ch === '{') {
      // nested rule (CSS nesting) — stop: only the rule's own declarations matter here
      break
    }
    i++
  }
  flush(Math.min(i, end))
  return out
}

export function locateRule(text: string, path: number[], selectorText?: string, tree = parseRuleTree(text)): RuleLocation | undefined {
  let node: RuleNode | undefined = tree
  for (const idx of path) {
    node = node?.children[idx]
    if (!node) return undefined
  }
  if (!node || node === tree) return undefined
  const before = text.slice(0, node.start)
  const line = before.split('\n').length
  const column = node.start - before.lastIndexOf('\n')
  const exact = selectorText === undefined || norm(node.prelude) === norm(selectorText)
  const declarations =
    node.bodyStart !== undefined && node.bodyEnd !== undefined ? parseDeclarations(text, node.bodyStart, node.bodyEnd) : new Map()
  return { line, column, exact, declarations }
}
