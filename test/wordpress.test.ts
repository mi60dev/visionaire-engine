/**
 * Pure resolver tests on fixture metadata — SPEC §7.3 table, no browser.
 */
import { describe, expect, it } from 'vitest'
import {
  detectPlatform,
  resolveWpOrigin,
  wpOriginToStyleOrigin,
} from '../src/attribution/wordpress.js'
import type { WpSheetMeta } from '../src/types.js'

const SITE = 'https://example.com'

function meta(partial: Partial<WpSheetMeta> & { sourceURL?: string }): WpSheetMeta {
  return { sourceURL: partial.sourceURL ?? `${SITE}/`, isInline: partial.isInline ?? false, ...partial }
}

describe('resolveWpOrigin — SPEC §7.3 detection table', () => {
  it('owner id wp-custom-css → customizer-css', () => {
    const wp = resolveWpOrigin(meta({ ownerNodeAttrId: 'wp-custom-css', isInline: true }))
    expect(wp).toEqual({ kind: 'customizer-css' })
  })

  it('owner id global-styles-inline-css → global-styles (not the generic -inline-css rule)', () => {
    const wp = resolveWpOrigin(meta({ ownerNodeAttrId: 'global-styles-inline-css', isInline: true }))
    expect(wp?.kind).toBe('global-styles')
    expect(wp?.handle).toBeUndefined()
  })

  it('owner id wp-block-library-css → block-library', () => {
    const wp = resolveWpOrigin(
      meta({
        sourceURL: `${SITE}/wp-includes/css/dist/block-library/style.min.css?ver=6.9`,
        ownerNodeAttrId: 'wp-block-library-css',
      }),
    )
    expect(wp?.kind).toBe('block-library')
  })

  it('owner id core-block-supports-inline-css → block-supports (not inline-handle)', () => {
    const wp = resolveWpOrigin(meta({ ownerNodeAttrId: 'core-block-supports-inline-css', isInline: true }))
    expect(wp?.kind).toBe('block-supports')
  })

  it('owner id {handle}-inline-css → inline-handle with extracted handle', () => {
    const wp = resolveWpOrigin(meta({ ownerNodeAttrId: 'astra-theme-css-inline-css', isInline: true }))
    expect(wp).toEqual({ kind: 'inline-handle', handle: 'astra-theme-css' })
  })

  it('elementor post CSS URL → elementor-post with postId', () => {
    const wp = resolveWpOrigin(
      meta({ sourceURL: `${SITE}/wp-content/uploads/elementor/css/post-88.css?ver=1719400000` }),
    )
    expect(wp).toEqual({ kind: 'elementor-post', postId: 88 })
  })

  it('elementor post CSS + .elementor-element-{id} selector → widgetId extracted', () => {
    const wp = resolveWpOrigin(
      meta({
        sourceURL: `${SITE}/wp-content/uploads/elementor/css/post-88.css`,
        selector: '.elementor-88 .elementor-element.elementor-element-4f2a1c > .elementor-widget-container',
      }),
    )
    expect(wp?.kind).toBe('elementor-post')
    expect(wp?.postId).toBe(88)
    expect(wp?.widgetId).toBe('4f2a1c')
  })

  it('elementor global.css → elementor-global', () => {
    const wp = resolveWpOrigin(meta({ sourceURL: `${SITE}/wp-content/uploads/elementor/css/global.css?ver=3` }))
    expect(wp?.kind).toBe('elementor-global')
  })

  it('et-cache URL → divi-generated', () => {
    const wp = resolveWpOrigin(
      meta({ sourceURL: `${SITE}/wp-content/et-cache/123/en/style-critical.min.css` }),
    )
    expect(wp?.kind).toBe('divi-generated')
  })

  it('autoptimize bundle → optimizer-bundle with ?ao_noptimize=1 bypass', () => {
    const wp = resolveWpOrigin(
      meta({ sourceURL: `${SITE}/wp-content/cache/autoptimize/css/autoptimize_a1b2c3.css` }),
    )
    expect(wp).toEqual({ kind: 'optimizer-bundle', bypassHint: '?ao_noptimize=1' })
  })

  it('wp-rocket bundle → optimizer-bundle with ?nowprocket bypass', () => {
    const wp = resolveWpOrigin(
      meta({ sourceURL: `${SITE}/wp-content/cache/wp-rocket/example.com/style-combined.min.css` }),
    )
    expect(wp).toEqual({ kind: 'optimizer-bundle', bypassHint: '?nowprocket' })
  })

  it('cache/min bundle → optimizer-bundle with ?nowprocket bypass', () => {
    const wp = resolveWpOrigin(
      meta({ sourceURL: `${SITE}/wp-content/cache/min/1/wp-content/themes/astra/style.min.css` }),
    )
    expect(wp).toEqual({ kind: 'optimizer-bundle', bypassHint: '?nowprocket' })
  })

  it('theme URL → theme with slug', () => {
    const wp = resolveWpOrigin(
      meta({ sourceURL: `${SITE}/wp-content/themes/astra/assets/css/minified/main.min.css?ver=4.6.2` }),
    )
    expect(wp).toEqual({ kind: 'theme', slug: 'astra' })
  })

  it('plugin URL → plugin with slug', () => {
    const wp = resolveWpOrigin(
      meta({ sourceURL: `${SITE}/wp-content/plugins/woocommerce/assets/css/woocommerce.css?ver=9.0` }),
    )
    expect(wp).toEqual({ kind: 'plugin', slug: 'woocommerce' })
  })

  it('non-WP URL with no owner markers → undefined', () => {
    expect(resolveWpOrigin(meta({ sourceURL: 'https://cdn.example.net/assets/app.3f9a.css' }))).toBeUndefined()
    expect(resolveWpOrigin(meta({ sourceURL: '', isInline: true }))).toBeUndefined()
  })

  it('generated-URL rules run before the theme rule (optimizer bundle inside cache dir)', () => {
    // URL mentions both /cache/min/ and a theme path — optimizer must win by table order.
    const wp = resolveWpOrigin(
      meta({ sourceURL: `${SITE}/wp-content/cache/min/1/wp-content/themes/astra/main.css` }),
    )
    expect(wp?.kind).toBe('optimizer-bundle')
  })
})

describe('wpOriginToStyleOrigin — granularity / label / edit surface', () => {
  it('elementor-post with widgetId → db-entity, widget in edit surface', () => {
    const m = meta({
      sourceURL: `${SITE}/wp-content/uploads/elementor/css/post-88.css`,
      selector: '.elementor-element-4f2a1c',
    })
    const wp = resolveWpOrigin(m)!
    const origin = wpOriginToStyleOrigin(wp, m)
    expect(origin.granularity).toBe('db-entity')
    expect(origin.label).toBe('Elementor (post 88)')
    expect(origin.editSurface).toBe('Elementor editor for post 88 > widget 4f2a1c')
    expect(origin.wp).toBe(wp)
  })

  it('elementor-post without widgetId → generated', () => {
    const m = meta({ sourceURL: `${SITE}/wp-content/uploads/elementor/css/post-88.css` })
    const origin = wpOriginToStyleOrigin(resolveWpOrigin(m)!, m)
    expect(origin.granularity).toBe('generated')
    expect(origin.editSurface).toBe('Elementor editor for post 88')
    expect(origin.file).toBe('uploads/elementor/css/post-88.css')
  })

  it('theme → line granularity, file relative from /wp-content/', () => {
    const m = meta({ sourceURL: `${SITE}/wp-content/themes/astra-child/style.css?ver=1.0` })
    const origin = wpOriginToStyleOrigin(resolveWpOrigin(m)!, m)
    expect(origin.granularity).toBe('line')
    expect(origin.label).toBe('theme: astra-child')
    expect(origin.file).toBe('themes/astra-child/style.css')
    expect(origin.editSurface).toBe('edit themes/astra-child/style.css')
  })

  it('plugin → line granularity with overwrite warning', () => {
    const m = meta({ sourceURL: `${SITE}/wp-content/plugins/elementor/assets/css/frontend.min.css` })
    const origin = wpOriginToStyleOrigin(resolveWpOrigin(m)!, m)
    expect(origin.granularity).toBe('line')
    expect(origin.label).toBe('plugin: elementor')
    expect(origin.file).toBe('plugins/elementor/assets/css/frontend.min.css')
    expect(origin.editSurface).toContain('prefer overriding')
  })

  it('customizer-css → db-entity pointing at Additional CSS', () => {
    const m = meta({ ownerNodeAttrId: 'wp-custom-css', isInline: true })
    const origin = wpOriginToStyleOrigin(resolveWpOrigin(m)!, m)
    expect(origin.granularity).toBe('db-entity')
    expect(origin.editSurface).toContain('Additional CSS')
  })

  it('block-library → file granularity with do-not-edit surface', () => {
    const m = meta({
      sourceURL: `${SITE}/wp-includes/css/dist/block-library/style.min.css?ver=6.9`,
      ownerNodeAttrId: 'wp-block-library-css',
    })
    const origin = wpOriginToStyleOrigin(resolveWpOrigin(m)!, m)
    expect(origin.granularity).toBe('file')
    expect(origin.file).toBe('/wp-includes/css/dist/block-library/style.min.css')
    expect(origin.editSurface).toContain('do not edit')
  })

  it('inline-handle → db-entity naming wp_add_inline_style(handle)', () => {
    const m = meta({ ownerNodeAttrId: 'my-plugin-inline-css', isInline: true })
    const origin = wpOriginToStyleOrigin(resolveWpOrigin(m)!, m)
    expect(origin.granularity).toBe('db-entity')
    expect(origin.editSurface).toContain("wp_add_inline_style('my-plugin')")
  })

  it('optimizer-bundle → generated with bypass hint surfaced', () => {
    const m = meta({ sourceURL: `${SITE}/wp-content/cache/autoptimize/css/autoptimize_x.css` })
    const origin = wpOriginToStyleOrigin(resolveWpOrigin(m)!, m)
    expect(origin.granularity).toBe('generated')
    expect(origin.editSurface).toContain('?ao_noptimize=1')
    expect(origin.wp?.bypassHint).toBe('?ao_noptimize=1')
  })

  it('divi-generated and elementor-global and global-styles map to their surfaces', () => {
    const divi = meta({ sourceURL: `${SITE}/wp-content/et-cache/9/style.min.css` })
    expect(wpOriginToStyleOrigin(resolveWpOrigin(divi)!, divi).granularity).toBe('generated')

    const eg = meta({ sourceURL: `${SITE}/wp-content/uploads/elementor/css/global.css` })
    const egOrigin = wpOriginToStyleOrigin(resolveWpOrigin(eg)!, eg)
    expect(egOrigin.granularity).toBe('db-entity')
    expect(egOrigin.editSurface).toContain('Site Settings')

    const gs = meta({ ownerNodeAttrId: 'global-styles-inline-css', isInline: true })
    const gsOrigin = wpOriginToStyleOrigin(resolveWpOrigin(gs)!, gs)
    expect(gsOrigin.granularity).toBe('db-entity')
    expect(gsOrigin.editSurface).toContain('Site Editor')
  })
})

describe('detectPlatform — SPEC §7.3 page-level detection', () => {
  const wpElementorSheets = [
    { sourceURL: `${SITE}/wp-includes/css/dist/block-library/style.min.css?ver=6.9` },
    { sourceURL: `${SITE}/wp-content/themes/astra/assets/css/minified/main.min.css?ver=4.6` },
    { sourceURL: `${SITE}/wp-content/themes/astra/assets/css/minified/header.min.css?ver=4.6` },
    { sourceURL: `${SITE}/wp-content/themes/astra-child/style.css?ver=1.2` },
    { sourceURL: `${SITE}/wp-content/plugins/elementor/assets/css/frontend.min.css?ver=3.2` },
    { sourceURL: `${SITE}/wp-content/uploads/elementor/css/post-88.css?ver=1719` },
    { sourceURL: `${SITE}/wp-content/uploads/elementor/css/global.css?ver=3` },
    { sourceURL: '' }, // inline sheet: empty sourceURL must not break detection
  ]

  it('realistic WP + elementor page', () => {
    const info = detectPlatform(wpElementorSheets, {
      generator: 'WordPress 6.9',
      bodyClasses: ['home', 'elementor-default', 'elementor-page', 'elementor-page-88'],
    })
    expect(info.platform).toBe('wordpress')
    expect(info.version).toBe('6.9')
    expect(info.theme).toBe('astra')
    expect(info.childTheme).toBe('astra-child')
    expect(info.builders).toEqual(['elementor'])
    expect(info.optimizers).toEqual([])
  })

  it('detects WP from generator alone (no wp-content URLs)', () => {
    const info = detectPlatform([{ sourceURL: 'https://cdn.example.net/app.css' }], {
      generator: 'WordPress 6.9.1',
    })
    expect(info.platform).toBe('wordpress')
    expect(info.version).toBe('6.9.1')
  })

  it('child-theme heuristic: -child suffix wins even when parent serves style.css too', () => {
    const info = detectPlatform(
      [
        { sourceURL: `${SITE}/wp-content/themes/astra-child/style.css` },
        { sourceURL: `${SITE}/wp-content/themes/astra/style.css` },
        { sourceURL: `${SITE}/wp-content/themes/astra/assets/css/main.css` },
      ],
      {},
    )
    expect(info.theme).toBe('astra')
    expect(info.childTheme).toBe('astra-child')
  })

  it('child-theme heuristic: direct style.css marks the child when no -child slug', () => {
    const info = detectPlatform(
      [
        { sourceURL: `${SITE}/wp-content/themes/customtheme/style.css` },
        { sourceURL: `${SITE}/wp-content/themes/basetheme/assets/main.css` },
        { sourceURL: `${SITE}/wp-content/themes/basetheme/assets/header.css` },
      ],
      {},
    )
    expect(info.theme).toBe('basetheme')
    expect(info.childTheme).toBe('customtheme')
  })

  it('detects divi from body class and optimizers from bundle URLs', () => {
    const info = detectPlatform(
      [
        { sourceURL: `${SITE}/wp-content/cache/wp-rocket/example.com/all.min.css` },
        { sourceURL: `${SITE}/wp-content/cache/autoptimize/css/autoptimize_x.css` },
        { sourceURL: `${SITE}/wp-content/et-cache/12/style.min.css` },
      ],
      { bodyClasses: ['et_divi_theme'] },
    )
    expect(info.platform).toBe('wordpress')
    expect(info.builders).toEqual(['divi'])
    expect(info.optimizers.sort()).toEqual(['autoptimize', 'wp-rocket'])
  })

  it('elementor detected from body class alone', () => {
    const info = detectPlatform([], { bodyClasses: ['elementor-page'] })
    expect(info.platform).toBe('wordpress')
    expect(info.builders).toEqual(['elementor'])
  })

  it('non-WP page → platform undefined, empty builders/optimizers, no version', () => {
    const info = detectPlatform(
      [
        { sourceURL: 'https://cdn.shopify.com/s/files/theme.css' },
        { sourceURL: 'https://example.net/static/app.min.css' },
      ],
      { generator: 'Hugo 0.148.0' },
    )
    expect(info.platform).toBeUndefined()
    expect(info.version).toBeUndefined()
    expect(info.theme).toBeUndefined()
    expect(info.childTheme).toBeUndefined()
    expect(info.builders).toEqual([])
    expect(info.optimizers).toEqual([])
  })
})
