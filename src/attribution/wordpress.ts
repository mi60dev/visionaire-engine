/**
 * WordPress origin resolver — SPEC §7.3, convention mode, zero WP cooperation.
 * Pure functions over sheet metadata + document markers; no browser required
 * (except detectPlatformFromPage, the one CDP convenience wrapper at the bottom).
 */
import type { CDPSession } from 'puppeteer-core'
import type { PlatformInfo, StyleOrigin, WpOrigin, WpOriginKind, WpSheetMeta } from '../types.js'

const ELEMENTOR_WIDGET_SELECTOR = /\.elementor-element-([a-f0-9]+)/
const ELEMENTOR_POST_CSS = /\/wp-content\/uploads\/elementor\/css\/post-(\d+)\.css/
const ELEMENTOR_GLOBAL_CSS = /\/uploads\/elementor\/css\/global\.css/
const THEME_URL = /\/wp-content\/themes\/([^/]+)\//
const PLUGIN_URL = /\/wp-content\/plugins\/([^/]+)\//
const INLINE_HANDLE_ID = /^(.+)-inline-css$/

const OPTIMIZER_BUNDLES: ReadonlyArray<{ pattern: RegExp; name: string; bypassHint: string }> = [
  { pattern: /\/wp-content\/cache\/autoptimize\//, name: 'autoptimize', bypassHint: '?ao_noptimize=1' },
  { pattern: /\/cache\/wp-rocket\//, name: 'wp-rocket', bypassHint: '?nowprocket' },
  // WP Rocket's minify cache lives under wp-content/cache/min/{domain}/…
  { pattern: /\/cache\/min\//, name: 'wp-rocket', bypassHint: '?nowprocket' },
]

type WpRule = (meta: WpSheetMeta) => WpOrigin | undefined

/**
 * SPEC §7.3 detection table, checked in order. Order is load-bearing: the exact
 * owner-id rules (e.g. `global-styles-inline-css`) must run before the generic
 * `{handle}-inline-css` suffix rule, and generated-URL rules before theme/plugin.
 */
const DETECTION_TABLE: readonly WpRule[] = [
  (m) => (m.ownerNodeAttrId === 'wp-custom-css' ? { kind: 'customizer-css' } : undefined),
  (m) => (m.ownerNodeAttrId === 'global-styles-inline-css' ? { kind: 'global-styles' } : undefined),
  (m) => (m.ownerNodeAttrId === 'wp-block-library-css' ? { kind: 'block-library' } : undefined),
  (m) => (m.ownerNodeAttrId === 'core-block-supports-inline-css' ? { kind: 'block-supports' } : undefined),
  (m) => {
    const h = m.ownerNodeAttrId === undefined ? null : INLINE_HANDLE_ID.exec(m.ownerNodeAttrId)
    return h ? { kind: 'inline-handle', handle: h[1] } : undefined
  },
  (m) => {
    const p = ELEMENTOR_POST_CSS.exec(m.sourceURL)
    if (!p) return undefined
    const w = m.selector === undefined ? null : ELEMENTOR_WIDGET_SELECTOR.exec(m.selector)
    const origin: WpOrigin = { kind: 'elementor-post', postId: Number(p[1]) }
    if (w) origin.widgetId = w[1]
    return origin
  },
  (m) => (ELEMENTOR_GLOBAL_CSS.test(m.sourceURL) ? { kind: 'elementor-global' } : undefined),
  (m) => (m.sourceURL.includes('/et-cache/') ? { kind: 'divi-generated' } : undefined),
  (m) => {
    const opt = OPTIMIZER_BUNDLES.find((o) => o.pattern.test(m.sourceURL))
    return opt ? { kind: 'optimizer-bundle', bypassHint: opt.bypassHint } : undefined
  },
  (m) => {
    const t = THEME_URL.exec(m.sourceURL)
    return t ? { kind: 'theme', slug: t[1] } : undefined
  },
  (m) => {
    const p = PLUGIN_URL.exec(m.sourceURL)
    return p ? { kind: 'plugin', slug: p[1] } : undefined
  },
]

export function resolveWpOrigin(meta: WpSheetMeta): WpOrigin | undefined {
  for (const rule of DETECTION_TABLE) {
    const hit = rule(meta)
    if (hit) return hit
  }
  return undefined
}

/** Path relative from /wp-content/ (SPEC §8.3 shows e.g. `themes/astra-child/style.css`). */
function wpContentRelative(url: string): string | undefined {
  const m = /\/wp-content\/(.+?)(?:[?#]|$)/.exec(url)
  return m ? m[1] : undefined
}

function urlPath(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url.split(/[?#]/)[0] ?? url
  }
}

function themeLike(label: string, meta: WpSheetMeta): Omit<StyleOrigin, 'wp'> {
  const file = wpContentRelative(meta.sourceURL) ?? urlPath(meta.sourceURL)
  return { granularity: 'line', label, editSurface: `edit ${file}`, file }
}

const KIND_TABLE: Record<WpOriginKind, (wp: WpOrigin, meta: WpSheetMeta) => Omit<StyleOrigin, 'wp'>> = {
  'customizer-css': () => ({
    granularity: 'db-entity',
    label: 'Customizer > Additional CSS',
    editSurface: 'Appearance → Customize → Additional CSS (stored as custom_css post)',
  }),
  'global-styles': () => ({
    granularity: 'db-entity',
    label: 'Global Styles',
    editSurface: 'Site Editor → Styles (theme.json / wp_global_styles)',
  }),
  'block-library': (_wp, meta) => ({
    granularity: 'file',
    label: 'WordPress core block library',
    editSurface: 'core file — do not edit; override in theme or Additional CSS',
    file: urlPath(meta.sourceURL),
  }),
  'block-supports': () => ({
    granularity: 'db-entity',
    label: 'block supports CSS',
    editSurface: 'per-block attributes in the post editor',
  }),
  'inline-handle': (wp) => ({
    granularity: 'db-entity',
    label: `inline CSS for handle '${wp.handle}'`,
    editSurface: `wp_add_inline_style('${wp.handle}') — theme/plugin options that print CSS`,
  }),
  'elementor-post': (wp, meta) => {
    const base: Omit<StyleOrigin, 'wp'> = {
      // widget known → precise db-entity; else honest 'generated' (file exists but is not the edit surface)
      granularity: wp.widgetId ? 'db-entity' : 'generated',
      label: `Elementor (post ${wp.postId})`,
      editSurface:
        `Elementor editor for post ${wp.postId}` + (wp.widgetId ? ` > widget ${wp.widgetId}` : ''),
    }
    const file = wpContentRelative(meta.sourceURL)
    if (file) base.file = file
    return base
  },
  'elementor-global': () => ({
    granularity: 'db-entity',
    label: 'Elementor global styles',
    editSurface: 'Elementor → Site Settings',
  }),
  'divi-generated': (_wp, meta) => {
    const base: Omit<StyleOrigin, 'wp'> = {
      granularity: 'generated',
      label: 'Divi generated CSS (et-cache)',
      editSurface: 'Divi builder for that post — rebuild the et-cache after editing',
    }
    const file = wpContentRelative(meta.sourceURL)
    if (file) base.file = file
    return base
  },
  'optimizer-bundle': (wp, meta) => {
    const base: Omit<StyleOrigin, 'wp'> = {
      granularity: 'generated',
      label: 'optimizer bundle',
      editSurface: wp.bypassHint
        ? `generated bundle — re-inspect with bypass query param ${wp.bypassHint}`
        : 'generated bundle — do not edit',
    }
    const file = wpContentRelative(meta.sourceURL)
    if (file) base.file = file
    return base
  },
  // No 'child-theme' entry: parent/child is a page-level distinction (detectPlatform only).
  theme: (wp, meta) => themeLike(`theme: ${wp.slug}`, meta),
  plugin: (wp, meta) => {
    const file = wpContentRelative(meta.sourceURL) ?? urlPath(meta.sourceURL)
    return {
      granularity: 'line',
      label: `plugin: ${wp.slug}`,
      editSurface: `edit ${file} (plugin updates overwrite — prefer overriding)`,
      file,
    }
  },
}

export function wpOriginToStyleOrigin(wp: WpOrigin, meta: WpSheetMeta): StyleOrigin {
  return { ...KIND_TABLE[wp.kind](wp, meta), wp }
}

/** Page-level detection for `page_origins` — SPEC §7.3 bottom paragraph. */
export function detectPlatform(
  sheets: Array<{ sourceURL: string }>,
  docMarkers: { generator?: string; bodyClasses?: string[] },
): PlatformInfo {
  const urls = sheets.map((s) => s.sourceURL)
  const generator = docMarkers.generator ?? ''
  const body = docMarkers.bodyClasses ?? []
  const info: PlatformInfo = { builders: [], optimizers: [] }

  const isWp =
    urls.some((u) => u.includes('/wp-content/') || u.includes('/wp-includes/')) ||
    /wordpress/i.test(generator) ||
    body.includes('elementor-page') ||
    body.includes('et_divi_theme')
  if (!isWp) return info

  info.platform = 'wordpress'
  const version = /wordpress\s*(\d[\w.-]*)/i.exec(generator)?.[1]
  if (version) info.version = version

  interface ThemeStat {
    slug: string
    count: number
    directStyleCss: boolean
  }
  const stats: ThemeStat[] = []
  for (const u of urls) {
    const m = THEME_URL.exec(u)
    if (!m) continue
    const slug = m[1]
    let s = stats.find((t) => t.slug === slug)
    if (!s) {
      s = { slug, count: 0, directStyleCss: false }
      stats.push(s)
    }
    s.count++
    const path = u.split(/[?#]/)[0] ?? ''
    if (path.endsWith(`/wp-content/themes/${slug}/style.css`)) s.directStyleCss = true
  }
  if (stats.length === 1) {
    info.theme = stats[0].slug
  } else if (stats.length >= 2) {
    // Sheet count alone cannot tell parent from child; heuristic (SPEC §7.3 note):
    // '-child' in the slug, else the slug serving style.css directly, marks the child.
    const ranked = [...stats].sort((a, b) => b.count - a.count)
    const a = ranked[0]
    const b = ranked[1]
    let child: ThemeStat
    const aChild = a.slug.includes('-child')
    const bChild = b.slug.includes('-child')
    if (aChild !== bChild) child = aChild ? a : b
    else if (a.directStyleCss !== b.directStyleCss) child = a.directStyleCss ? a : b
    else child = b
    const theme = child === a ? b : a
    info.theme = theme.slug
    info.childTheme = child.slug
  }

  if (
    urls.some(
      (u) => ELEMENTOR_POST_CSS.test(u) || ELEMENTOR_GLOBAL_CSS.test(u) || u.includes('/plugins/elementor/'),
    ) ||
    body.includes('elementor-page')
  ) {
    info.builders.push('elementor')
  }
  if (urls.some((u) => u.includes('/et-cache/') || u.includes('/themes/Divi/')) || body.includes('et_divi_theme')) {
    info.builders.push('divi')
  }

  for (const o of OPTIMIZER_BUNDLES) {
    if (!info.optimizers.includes(o.name) && urls.some((u) => o.pattern.test(u))) {
      info.optimizers.push(o.name)
    }
  }
  return info
}

/** Document markers detectPlatform needs, collected in one Runtime.evaluate. */
export const DOC_MARKERS_EXPRESSION = `(() => ({
  generator: Array.from(document.querySelectorAll('meta[name="generator" i]'))
    .map((m) => m.getAttribute('content') || '').filter(Boolean).join(' | ') || undefined,
  bodyClasses: document.body ? Array.from(document.body.classList) : [],
}))()`

/**
 * detectPlatform against the live page: fetch the document markers with a
 * single Runtime.evaluate, then run the pure detector over the sheet URLs.
 * Shared entry point for the census platform header (page_snapshot) and any
 * other tool that needs page-level platform detection.
 */
export async function detectPlatformFromPage(
  cdp: CDPSession,
  sheets: Array<{ sourceURL: string }>,
): Promise<PlatformInfo> {
  const res = await cdp.send('Runtime.evaluate', {
    expression: DOC_MARKERS_EXPRESSION,
    returnByValue: true,
  })
  const markers = (res.result.value ?? {}) as { generator?: string; bodyClasses?: string[] }
  return detectPlatform(sheets, markers)
}
