/**
 * Closed ruleset for stacking-context creation — SPEC §6.4.
 *
 * The flex/grid-item rule needs the parent's display; callers pass it under
 * the non-standard map key 'parent-display' (absent → that rule is skipped).
 * The root element is always a stacking context — that is the caller's check,
 * since it is not derivable from a computed-style map.
 */

const NONE_VALUED_CREATORS = [
  'transform',
  'filter',
  'perspective',
  'clip-path',
  'mask',
  'mask-image',
  'backdrop-filter',
] as const

const WILL_CHANGE_TRIGGERS = new Set([
  'transform',
  'opacity',
  'filter',
  'perspective',
  'clip-path',
  'mask',
  'mask-image',
  'backdrop-filter',
  'isolation',
  'mix-blend-mode',
  'z-index',
  'position',
  'contain',
])

export function stackingContextReason(computed: Map<string, string>): string | undefined {
  const get = (prop: string): string => (computed.get(prop) ?? '').trim()

  const position = get('position')
  const zIndex = get('z-index')
  const hasZIndex = zIndex !== '' && zIndex !== 'auto'

  if (position === 'fixed' || position === 'sticky') {
    return `creates stacking context: position:${position}`
  }
  if (hasZIndex && position !== '' && position !== 'static') {
    return `creates stacking context: position:${position} + z-index:${zIndex}`
  }
  const parentDisplay = get('parent-display')
  if (hasZIndex && /\b(flex|grid)\b/.test(parentDisplay)) {
    const kind = parentDisplay.includes('grid') ? 'grid' : 'flex'
    return `creates stacking context: ${kind} item + z-index:${zIndex}`
  }
  const opacity = get('opacity')
  if (opacity !== '' && Number.parseFloat(opacity) < 1) {
    return `creates stacking context: opacity:${opacity}`
  }
  for (const prop of NONE_VALUED_CREATORS) {
    const value = get(prop)
    if (value !== '' && value !== 'none') return `creates stacking context: ${prop}`
  }
  if (get('isolation') === 'isolate') return 'creates stacking context: isolation:isolate'
  const blend = get('mix-blend-mode')
  if (blend !== '' && blend !== 'normal') {
    return `creates stacking context: mix-blend-mode:${blend}`
  }
  const willChange = get('will-change')
  if (willChange !== '' && willChange !== 'auto') {
    const named = willChange
      .split(',')
      .map((w) => w.trim())
      .filter((w) => WILL_CHANGE_TRIGGERS.has(w))
    if (named.length > 0) return `creates stacking context: will-change:${named.join(',')}`
  }
  const contain = get('contain')
  if (/\b(layout|paint|strict|content)\b/.test(contain)) {
    return `creates stacking context: contain:${contain}`
  }
  return undefined
}
