/**
 * Color math for pixel-perfect verdicts: parse CSS color strings, WCAG relative
 * luminance, contrast ratio, and AA/AAA pass/fail phrasing. Pure functions.
 */

export type Rgba = [number, number, number, number]

/** Parse 'rgb(…)', 'rgba(…)', '#rrggbb', '#rgb'. Returns undefined for anything else. */
export function parseCssColor(input: string): Rgba | undefined {
  const s = input.trim().toLowerCase()
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s)
  if (fn) {
    return [Number(fn[1]), Number(fn[2]), Number(fn[3]), fn[4] !== undefined ? Number(fn[4]) : 1]
  }
  const hex6 = /^#([0-9a-f]{6})$/.exec(s)
  if (hex6) {
    const v = parseInt(hex6[1]!, 16)
    return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff, 1]
  }
  const hex3 = /^#([0-9a-f]{3})$/.exec(s)
  if (hex3) {
    const [r, g, b] = hex3[1]!.split('')
    return [parseInt(r! + r!, 16), parseInt(g! + g!, 16), parseInt(b! + b!, 16), 1]
  }
  return undefined
}

export function toHex([r, g, b]: Rgba): string {
  const h = (v: number): string => Math.round(v).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance([r, g, b]: Rgba): number {
  const lin = (c: number): number => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG contrast ratio, ≥1. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/** "4.72:1 — AA normal ✓, AAA ✗ (needs 7)" */
export function contrastVerdict(ratio: number): string {
  const r = Math.round(ratio * 100) / 100
  const aa = ratio >= 4.5 ? 'AA normal ✓' : ratio >= 3 ? 'AA normal ✗ (AA large-text ✓)' : 'AA ✗ (needs 4.5)'
  const aaa = ratio >= 7 ? 'AAA ✓' : 'AAA ✗ (needs 7)'
  return `${r}:1 — ${aa}, ${aaa}`
}
