/**
 * Group-geometry analysis — the pixel-perfect audit for SETS of elements:
 * edge/center alignment clusters, gap-rhythm outliers, size consistency,
 * grid conformance, and pixel-snap (fractional coordinates that render blurry).
 * Pure math over fractional rects — unit-testable without a browser.
 */

export interface AlignBox {
  uid: string
  identity: string
  x: number
  y: number
  w: number
  h: number
}

export interface AlignmentOptions {
  /** Two values within this many px count as aligned. */
  tolerance?: number
  /** Flag positions/gaps that sit off an N-px grid. */
  gridUnit?: number
  /** Device pixel ratio for the pixel-snap check (1 = desktop default). */
  dpr?: number
}

interface Cluster {
  mean: number
  members: number[] // indexes into the boxes array
}

function clusters(values: number[], tol: number): Cluster[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v)
  const out: Cluster[] = []
  for (const { v, i } of order) {
    const last = out[out.length - 1]
    if (last && v - last.mean <= tol) {
      last.members.push(i)
      last.mean = last.members.reduce((s, m) => s + values[m]!, 0) / last.members.length
    } else {
      out.push({ mean: v, members: [i] })
    }
  }
  return out.sort((a, b) => b.members.length - a.members.length)
}

const r1 = (v: number): string => (Math.round(v * 10) / 10).toFixed(1)

function edgeLine(name: string, values: number[], boxes: AlignBox[], tol: number): string | undefined {
  if (values.length < 2) return undefined
  const cs = clusters(values, tol)
  const main = cs[0]!
  if (main.members.length === values.length) return `${name}: all ${values.length} aligned at ${r1(main.mean)}px ✓`
  if (main.members.length >= values.length - 2 && main.members.length >= 2) {
    const outliers = cs
      .slice(1)
      .flatMap((c) => c.members)
      .map((i) => {
        const d = values[i]! - main.mean
        return `${boxes[i]!.uid} at ${r1(values[i]!)} (${d > 0 ? '+' : ''}${r1(d)}px)`
      })
    return `⚠ ${name}: ${main.members.length}/${values.length} aligned at ${r1(main.mean)}px — off: ${outliers.join(', ')}`
  }
  return undefined // scattered — not an alignment relationship worth asserting
}

function gapLines(boxes: AlignBox[], axis: 'x' | 'y', tol: number): string[] {
  if (boxes.length < 3) return []
  const sorted = [...boxes].sort((a, b) => (axis === 'x' ? a.x - b.x : a.y - b.y))
  const gaps: { from: string; to: string; gap: number }[] = []
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i]!
    const b = sorted[i + 1]!
    gaps.push({
      from: a.uid,
      to: b.uid,
      gap: axis === 'x' ? b.x - (a.x + a.w) : b.y - (a.y + a.h),
    })
  }
  const values = gaps.map((g) => g.gap).sort((a, b) => a - b)
  const median = values[Math.floor(values.length / 2)]!
  const outliers = gaps.filter((g) => Math.abs(g.gap - median) > tol)
  const dir = axis === 'x' ? 'horizontal' : 'vertical'
  if (outliers.length === 0) {
    return [`gaps (${dir}): all ${gaps.length} ≈ ${r1(median)}px ✓`]
  }
  const detail = outliers
    .slice(0, 4)
    .map((g) => `${g.from}→${g.to} = ${r1(g.gap)}px (${g.gap - median > 0 ? '+' : ''}${r1(g.gap - median)})`)
  return [`⚠ gaps (${dir}): median ${r1(median)}px — outlier${outliers.length === 1 ? '' : 's'}: ${detail.join(', ')}`]
}

function gridLines(boxes: AlignBox[], unit: number, tol: number): string[] {
  const offs: string[] = []
  for (const b of boxes) {
    for (const [label, v] of [
      ['left', b.x],
      ['top', b.y],
    ] as const) {
      const rem = v % unit
      const dev = Math.min(rem, unit - rem)
      if (dev > tol) {
        const signed = rem <= unit / 2 ? rem : rem - unit
        offs.push(`${b.uid}.${label}=${r1(v)} (${signed > 0 ? '+' : ''}${r1(signed)})`)
      }
    }
  }
  if (offs.length === 0) return [`grid (${unit}px): all lefts/tops conform ✓`]
  return [`⚠ off ${unit}px grid: ${offs.slice(0, 5).join(', ')}${offs.length > 5 ? ` — +${offs.length - 5} more` : ''}`]
}

function pixelSnapLines(boxes: AlignBox[], dpr: number): string[] {
  const flagged: string[] = []
  for (const b of boxes) {
    const parts: string[] = []
    for (const [label, v] of [
      ['x', b.x],
      ['y', b.y],
      ['w', b.w],
      ['h', b.h],
    ] as const) {
      const device = v * dpr
      if (Math.abs(device - Math.round(device)) > 0.05) parts.push(`${label}=${r1(v)}`)
    }
    if (parts.length > 0) flagged.push(`${b.uid} ${parts.join(' ')}`)
  }
  if (flagged.length === 0) return []
  return [
    `⚠ pixel snap (dpr ${dpr}): ${flagged.slice(0, 4).join('; ')}${flagged.length > 4 ? ` — +${flagged.length - 4} more` : ''} — fractional device pixels can render blurry`,
  ]
}

export function analyzeAlignment(boxes: AlignBox[], opts: AlignmentOptions = {}): string[] {
  const tol = opts.tolerance ?? 0.5
  const dpr = opts.dpr ?? 1
  if (boxes.length < 2) return ['need at least 2 elements to audit alignment']

  const tops = boxes.map((b) => b.y)
  const lefts = boxes.map((b) => b.x)
  const isRow = clusters(tops, tol)[0]!.members.length >= clusters(lefts, tol)[0]!.members.length

  const lines: string[] = []
  lines.push(`alignment audit: ${boxes.length} elements (${isRow ? 'row' : 'column'} layout)`)

  const edges: Array<[string, number[]]> = isRow
    ? [
        ['tops', tops],
        ['vertical centers', boxes.map((b) => b.y + b.h / 2)],
        ['bottoms', boxes.map((b) => b.y + b.h)],
      ]
    : [
        ['lefts', lefts],
        ['horizontal centers', boxes.map((b) => b.x + b.w / 2)],
        ['rights', boxes.map((b) => b.x + b.w)],
      ]
  for (const [name, values] of edges) {
    const line = edgeLine(name, values, boxes, tol)
    if (line) lines.push(line)
  }

  for (const [name, values] of [
    ['widths', boxes.map((b) => b.w)],
    ['heights', boxes.map((b) => b.h)],
  ] as const) {
    const line = edgeLine(name, values, boxes, tol)
    if (line) lines.push(line)
  }

  lines.push(...gapLines(boxes, isRow ? 'x' : 'y', tol))
  if (opts.gridUnit && opts.gridUnit > 0) lines.push(...gridLines(boxes, opts.gridUnit, tol))
  lines.push(...pixelSnapLines(boxes, dpr))
  return lines
}
