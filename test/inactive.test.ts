import { describe, expect, it } from 'vitest'
import { findInactiveDeclarations } from '../src/engine/inactive.js'
import type { DeclarationInfo } from '../src/types.js'

function decl(property: string, value: string): DeclarationInfo {
  return { property, value, important: false, originType: 'matched' }
}

function cm(entries: Record<string, string> = {}): Map<string, string> {
  return new Map(Object.entries(entries))
}

describe('findInactiveDeclarations', () => {
  it('flags width on a non-replaced inline element', () => {
    const findings = findInactiveDeclarations([decl('width', '100%')], cm({ display: 'inline' }))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.reason).toContain('inline')
    expect(findings[0]!.fixHint).toContain('display:block')
  })

  it('does not flag width on a block element', () => {
    expect(findInactiveDeclarations([decl('width', '100%')], cm({ display: 'block' }))).toHaveLength(0)
  })

  it('flags vertical margins on inline elements', () => {
    const findings = findInactiveDeclarations(
      [decl('margin-top', '10px'), decl('margin-left', '10px')],
      cm({ display: 'inline' }),
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]!.decl.property).toBe('margin-top')
  })

  it('flags vertical-align on a block element but not on inline-block or table-cell', () => {
    expect(
      findInactiveDeclarations([decl('vertical-align', 'middle')], cm({ display: 'block' })),
    ).toHaveLength(1)
    expect(
      findInactiveDeclarations([decl('vertical-align', 'middle')], cm({ display: 'inline-block' })),
    ).toHaveLength(0)
    expect(
      findInactiveDeclarations([decl('vertical-align', 'middle')], cm({ display: 'table-cell' })),
    ).toHaveLength(0)
  })

  it('flags flex item properties when the parent is not a flex container', () => {
    const findings = findInactiveDeclarations(
      [decl('flex-grow', '1'), decl('align-self', 'center')],
      cm({ display: 'block' }),
      'block',
    )
    expect(findings).toHaveLength(2)
    expect(findings[0]!.reason).toContain('display:block')
    expect(findings[0]!.fixHint).toContain('display:flex')
  })

  it('does not flag flex item properties when the parent is flex, or when parent display is unknown', () => {
    expect(
      findInactiveDeclarations([decl('flex-grow', '1')], cm({ display: 'block' }), 'flex'),
    ).toHaveLength(0)
    expect(findInactiveDeclarations([decl('flex-grow', '1')], cm({ display: 'block' }))).toHaveLength(0)
  })

  it('accepts order and align-self on grid items, but not flex-grow', () => {
    expect(
      findInactiveDeclarations([decl('order', '2'), decl('align-self', 'end')], cm(), 'grid'),
    ).toHaveLength(0)
    expect(findInactiveDeclarations([decl('flex-grow', '1')], cm(), 'grid')).toHaveLength(1)
  })

  it('flags grid item properties when the parent is not a grid container', () => {
    const findings = findInactiveDeclarations([decl('grid-column', '1 / 3')], cm(), 'block')
    expect(findings).toHaveLength(1)
    expect(findings[0]!.fixHint).toContain('display:grid')
    expect(findInactiveDeclarations([decl('grid-column', '1 / 3')], cm(), 'grid')).toHaveLength(0)
  })

  it('flags container properties on a non-flex/grid element', () => {
    const findings = findInactiveDeclarations(
      [decl('justify-content', 'center'), decl('gap', '8px')],
      cm({ display: 'block' }),
    )
    expect(findings).toHaveLength(2)
    expect(
      findInactiveDeclarations([decl('justify-content', 'center')], cm({ display: 'flex' })),
    ).toHaveLength(0)
    expect(findInactiveDeclarations([decl('gap', '8px')], cm({ display: 'grid' }))).toHaveLength(0)
  })

  it('flags z-index on a position:static element that is not a flex/grid item', () => {
    const findings = findInactiveDeclarations(
      [decl('z-index', '9999')],
      cm({ position: 'static' }),
      'block',
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]!.fixHint).toContain('position:relative')
  })

  it('does not flag z-index on positioned elements, flex/grid items, or z-index:auto', () => {
    expect(
      findInactiveDeclarations([decl('z-index', '9999')], cm({ position: 'relative' })),
    ).toHaveLength(0)
    expect(
      findInactiveDeclarations([decl('z-index', '9999')], cm({ position: 'static' }), 'flex'),
    ).toHaveLength(0)
    expect(
      findInactiveDeclarations([decl('z-index', 'auto')], cm({ position: 'static' }), 'block'),
    ).toHaveLength(0)
  })

  it('flags top/right/bottom/left on position:static', () => {
    const findings = findInactiveDeclarations(
      [decl('top', '10px'), decl('left', '0')],
      cm({ position: 'static' }),
    )
    expect(findings).toHaveLength(2)
    expect(findInactiveDeclarations([decl('top', '10px')], cm({ position: 'absolute' }))).toHaveLength(0)
  })

  it('flags float on flex and grid items', () => {
    expect(findInactiveDeclarations([decl('float', 'left')], cm(), 'flex')).toHaveLength(1)
    expect(findInactiveDeclarations([decl('float', 'left')], cm(), 'grid')).toHaveLength(1)
    expect(findInactiveDeclarations([decl('float', 'left')], cm(), 'block')).toHaveLength(0)
    expect(findInactiveDeclarations([decl('float', 'none')], cm(), 'flex')).toHaveLength(0)
  })

  it('flags text-overflow:ellipsis without overflow:hidden + white-space:nowrap (heuristic)', () => {
    const findings = findInactiveDeclarations(
      [decl('text-overflow', 'ellipsis')],
      cm({ 'overflow-x': 'visible', 'white-space': 'normal' }),
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]!.reason).toContain('heuristic')
    expect(
      findInactiveDeclarations(
        [decl('text-overflow', 'ellipsis')],
        cm({ 'overflow-x': 'hidden', 'white-space': 'nowrap' }),
      ),
    ).toHaveLength(0)
  })

  it('flags position:sticky without any inset', () => {
    const findings = findInactiveDeclarations(
      [decl('position', 'sticky')],
      cm({ position: 'sticky', top: 'auto', right: 'auto', bottom: 'auto', left: 'auto' }),
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]!.fixHint).toContain('top:0')
    expect(
      findInactiveDeclarations(
        [decl('position', 'sticky')],
        cm({ position: 'sticky', top: '0px' }),
      ),
    ).toHaveLength(0)
  })

  it('returns one finding per declaration, first matching table entry wins', () => {
    // width on an inline static element: only the inline rule fires, not others.
    const findings = findInactiveDeclarations(
      [decl('width', '10px')],
      cm({ display: 'inline', position: 'static' }),
    )
    expect(findings).toHaveLength(1)
  })
})
