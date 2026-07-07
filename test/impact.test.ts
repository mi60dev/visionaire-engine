/**
 * Pure units for the impact engine: deterministic grouping, the documented
 * region-bucket rule, ARIA role implication, and group sort order.
 */
import { describe, it, expect } from 'vitest'
import { groupImpact, impliedRole, regionOf, type ImpactItem } from '../src/engine/impact.js'

let counter = 0
const item = (over: Partial<ImpactItem> = {}): ImpactItem => ({
  uid: `e${++counter}`,
  tag: 'div',
  classes: [],
  identity: '<div>',
  rect: { x: 0, y: 100, width: 100, height: 20 },
  ...over,
})

const rectAtCenterY = (cy: number) => ({ x: 0, y: cy - 10, width: 100, height: 20 })

describe('regionOf — documented bucket rule (center-y quartiles of the document)', () => {
  const H = 1000
  it('buckets center-y < 25% as top', () => {
    expect(regionOf(rectAtCenterY(0), H)).toBe('top')
    expect(regionOf(rectAtCenterY(249), H)).toBe('top')
  })
  it('buckets 25% <= center-y < 75% as middle', () => {
    expect(regionOf(rectAtCenterY(250), H)).toBe('middle')
    expect(regionOf(rectAtCenterY(749), H)).toBe('middle')
  })
  it('buckets center-y >= 75% as bottom', () => {
    expect(regionOf(rectAtCenterY(750), H)).toBe('bottom')
    expect(regionOf(rectAtCenterY(999), H)).toBe('bottom')
  })
  it('buckets rect-less items as unpositioned and degenerate page height as top', () => {
    expect(regionOf(undefined, H)).toBe('unpositioned')
    expect(regionOf(rectAtCenterY(500), 0)).toBe('top')
  })
})

describe('impliedRole', () => {
  it('maps the documented tags', () => {
    expect(impliedRole('a')).toBe('link')
    expect(impliedRole('button')).toBe('button')
    expect(impliedRole('nav')).toBe('navigation')
    expect(impliedRole('h1')).toBe('heading')
    expect(impliedRole('H4')).toBe('heading')
    expect(impliedRole('h6')).toBe('heading')
    expect(impliedRole('footer')).toBe('contentinfo')
    expect(impliedRole('header')).toBe('banner')
  })
  it('maps input per type: checkbox → checkbox, everything else → textbox', () => {
    expect(impliedRole('input', 'checkbox')).toBe('checkbox')
    expect(impliedRole('input', 'text')).toBe('textbox')
    expect(impliedRole('input')).toBe('textbox')
  })
  it('returns undefined for tags without an implied role', () => {
    expect(impliedRole('div')).toBeUndefined()
    expect(impliedRole('span')).toBeUndefined()
  })
})

describe('groupImpact — visual_role keys', () => {
  it('builds <tag>[.up-to-2-sorted-classes]@<region>[role=X]', () => {
    const items = [
      item({ uid: 'e1', tag: 'a', classes: ['nav-item'], identity: '<a.nav-item>', rect: rectAtCenterY(50) }),
    ]
    const groups = groupImpact(items, 'visual_role', 1000)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.key).toBe('a.nav-item@top[role=link]')
    expect(groups[0]!.region).toBe('top')
    expect(groups[0]!.sample_identity).toBe('<a.nav-item>')
  })

  it('sorts classes and caps them at 2 in the key', () => {
    const items = [item({ tag: 'div', classes: ['zeta', 'alpha', 'mid'], rect: rectAtCenterY(500) })]
    const groups = groupImpact(items, 'visual_role', 1000)
    expect(groups[0]!.key).toBe('div.alpha.mid@middle')
  })

  it('prefers an explicit role attribute over the implied one', () => {
    const items = [item({ tag: 'a', classes: [], role: 'tab', rect: rectAtCenterY(50) })]
    expect(groupImpact(items, 'visual_role', 1000)[0]!.key).toBe('a@top[role=tab]')
  })

  it('splits identical tag+classes by region', () => {
    const items = [
      item({ uid: 'e1', tag: 'a', classes: ['nav-item'], rect: rectAtCenterY(50) }),
      item({ uid: 'e2', tag: 'a', classes: ['nav-item'], rect: rectAtCenterY(950) }),
    ]
    const keys = groupImpact(items, 'visual_role', 1000).map((g) => g.key)
    expect(keys).toContain('a.nav-item@top[role=link]')
    expect(keys).toContain('a.nav-item@bottom[role=link]')
  })
})

describe('groupImpact — grouping determinism and sort order', () => {
  const items = [
    item({ uid: 'e1', tag: 'a', classes: ['nav-item'], rect: rectAtCenterY(50), identity: '<a.nav-item>' }),
    item({ uid: 'e2', tag: 'a', classes: ['nav-item'], rect: rectAtCenterY(60), identity: '<a.nav-item>' }),
    item({ uid: 'e3', tag: 'button', classes: ['nav-item'], rect: rectAtCenterY(500), identity: '<button.nav-item>' }),
    item({ uid: 'e4', tag: 'a', classes: ['nav-item'], rect: rectAtCenterY(950), identity: '<a.nav-item>' }),
    item({ uid: 'e5', tag: 'a', classes: ['nav-item'], rect: rectAtCenterY(955), identity: '<a.nav-item>' }),
  ]

  it('is deterministic: same input, same output', () => {
    const a = groupImpact(items, 'visual_role', 1000)
    const b = groupImpact(items, 'visual_role', 1000)
    expect(a).toEqual(b)
  })

  it('sorts by count desc then key asc, keeping uid input order inside groups', () => {
    const groups = groupImpact(items, 'visual_role', 1000)
    expect(groups.map((g) => [g.key, g.count])).toEqual([
      ['a.nav-item@bottom[role=link]', 2],
      ['a.nav-item@top[role=link]', 2],
      ['button.nav-item@middle[role=button]', 1],
    ])
    expect(groups[1]!.uids).toEqual(['e1', 'e2'])
  })

  it('groups by region alone', () => {
    const groups = groupImpact(items, 'region', 1000)
    expect(groups.map((g) => [g.key, g.count])).toEqual([
      ['bottom', 2],
      ['top', 2],
      ['middle', 1],
    ])
    expect(groups.every((g) => g.key === g.region)).toBe(true)
  })

  it('groups by tag with a canonical multi-region span', () => {
    const groups = groupImpact(items, 'tag', 1000)
    expect(groups.map((g) => [g.key, g.count])).toEqual([
      ['a', 4],
      ['button', 1],
    ])
    expect(groups[0]!.region).toBe('top,bottom')
    expect(groups[1]!.region).toBe('middle')
  })
})
