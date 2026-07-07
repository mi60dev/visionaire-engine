# WordPress origin resolution

Visionaire's headline trick: on a WordPress site, it doesn't just tell you *which CSS rule wins* — it tells you **where that rule actually lives and where to go edit it**, even when the "file" Chrome shows you is a generated artifact nobody should ever open.

This guide is for WordPress freelancers and agencies (you don't need to know what the Chrome DevTools Protocol is), and for LLM agents that will read visionaire's output and act on it.

- What the tools return in general: [tools.md](tools.md)
- How the pipeline works: [architecture.md](architecture.md)

---

## Why WordPress CSS debugging is uniquely painful

On a hand-built site, a CSS rule lives in a CSS file. On a WordPress site, the styles hitting any given element can come from **14+ different entry points**, and most of them are not files you can edit:

1. The active theme's stylesheets
2. A child theme overriding the parent
3. **Customizer → Additional CSS** (stored in the database as a `custom_css` post)
4. **Global Styles** — the Site Editor / `theme.json` output, printed inline as `<style id="global-styles-inline-css">` (stored as a `wp_global_styles` post)
5. Core's block library CSS (`wp-block-library`)
6. **Per-block "block supports" CSS** — generated from the attributes you set on individual blocks in the post editor
7. `wp_add_inline_style()` blobs — theme/plugin *options pages* that print CSS next to a registered handle
8. Plugin stylesheets (each plugin brings its own)
9. Must-use plugins (`mu-plugins`)
10. **Elementor's generated per-page CSS** (`uploads/elementor/css/post-{id}.css`) — compiled from widget settings stored in post meta
11. Elementor's site-wide `global.css` (Site Settings)
12. **Divi's generated cache** (`et-cache/`)
13. **Optimizer bundles** — WP Rocket, Autoptimize etc. concatenate/minify everything above into cache files, hiding the real origins
14. Inline `style=""` attributes written by builders and blocks

The killer problem: for at least half of these, **the right answer is a database entity, not a file**. Chrome DevTools will happily point you at `uploads/elementor/css/post-88.css:1` — a real file on disk — but editing it is useless: Elementor regenerates it from the database on the next save. The *actual* edit surface is a widget control inside the Elementor editor. Same story for Additional CSS, Global Styles, block supports, and every optimizer bundle.

Visionaire resolves each rule to its honest edit surface, and labels how confident that answer is.

---

## What visionaire detects — with zero WordPress cooperation

No plugin to install, no admin login, no WP-CLI, no REST API. **Convention mode** works purely from what any rendered page already exposes:

- **URL patterns** on stylesheet links — `/wp-content/themes/{slug}/…`, `/wp-content/plugins/{slug}/…`, `uploads/elementor/css/…`, `et-cache/`, optimizer cache paths;
- **WordPress's own fingerprints** — WordPress prints `id="{handle}-css"` on every enqueued `<link>` and `id="{handle}-inline-css"` on every `wp_add_inline_style()` block, plus well-known ids like `wp-custom-css` and `global-styles-inline-css`;
- **Document markers** — the `<meta name="generator">` tag and body classes like `elementor-page`.

It works on any URL Chrome can open. For a staging site behind a login, `connect { browserUrl: "http://127.0.0.1:9222" }` attaches to your real, logged-in browser.

The detection surfaces in two places:

- **`page_origins`** — every stylesheet on the page classified, plus a one-line platform summary (`platform: WordPress 6.9 | theme: astra | builders: elementor | optimizers: none detected`);
- **`explain_styles`** — every winning/losing declaration carries a bracket: `[granularity | label — edit surface]`.

### The granularity label (honesty ladder)

Every attribution says how good the answer is:

| Label | Means | On WordPress, typically |
|---|---|---|
| `line` | file + line known — edit exactly there | theme and plugin CSS files |
| `file` | file known, line unreliable | core block library; minified `.min.css` without a source map; source-map failures |
| `db-entity` | the origin is a **database entity** — the file (if any) is not the edit surface | Customizer CSS, Global Styles, block supports, inline handles, Elementor |
| `generated` | generated artifact — do not edit; a truer source exists | Elementor post CSS (widget unknown), Divi et-cache, optimizer bundles |
| `unknown` | none of the above; raw selector + sheet still shown | user-agent styles, unrecognized sheets |

---

## The detection table, rule by rule

The resolver (`src/attribution/wordpress.ts`) checks these rules **in order — first match wins**. Order is load-bearing: exact owner-ids run before the generic `{handle}-inline-css` suffix rule, and generated-URL rules run before the theme/plugin rules.

| # | Marker | Granularity | Edit-surface answer |
|---|---|---|---|
| 1 | `<style id="wp-custom-css">` | `db-entity` | Appearance → Customize → Additional CSS (stored as `custom_css` post) |
| 2 | `<style id="global-styles-inline-css">` | `db-entity` | Site Editor → Styles (`theme.json` / `wp_global_styles`) |
| 3 | owner id `wp-block-library-css` | `file` | core file — do not edit; override in theme or Additional CSS |
| 4 | owner id `core-block-supports-inline-css` | `db-entity` | per-block attributes in the post editor |
| 5 | owner id `{handle}-inline-css` | `db-entity` | `wp_add_inline_style('{handle}')` — theme/plugin options that print CSS |
| 6 | URL `…/wp-content/uploads/elementor/css/post-{id}.css` | `db-entity` (widget known) / `generated` | Elementor editor for post {id} > widget {wid} |
| 7 | URL `…/uploads/elementor/css/global.css` | `db-entity` | Elementor → Site Settings |
| 8 | URL contains `/et-cache/` | `generated` | Divi builder for that post — rebuild the et-cache after editing |
| 9 | URL `…/wp-content/cache/autoptimize/…`, `…/cache/wp-rocket/…`, `…/cache/min/…` | `generated` | re-inspect with the bypass query param (`?ao_noptimize=1` / `?nowprocket`) |
| 10 | URL `…/wp-content/themes/{slug}/…` | `line` | edit that file (path relative from `wp-content/`) |
| 11 | URL `…/wp-content/plugins/{slug}/…` | `line` | edit that file — *plugin updates overwrite; prefer overriding* |

What each one means in practice:

### 1. `wp-custom-css` — Customizer "Additional CSS"

The CSS box under **Appearance → Customize → Additional CSS**. WordPress stores it in the database (a `custom_css` post) and prints it inline on every page. There is no file. Attribution: `[db-entity | Customizer > Additional CSS — Appearance → Customize → Additional CSS (stored as custom_css post)]`. This is very often where a past freelancer's "quick fix" lives — and why you can't find it by grepping the theme.

### 2. `global-styles-inline-css` — Global Styles / theme.json

The compiled output of the Site Editor's **Styles** panel and the theme's `theme.json` (merged with user changes stored in a `wp_global_styles` post). On block themes this is where most typography, color presets (`--wp--preset--*` variables), and layout spacing come from. Edit in **Site Editor → Styles** (or `theme.json` if the value is untouched by the user).

### 3. `wp-block-library-css` — core block styles

WordPress core's stylesheet for blocks (`wp-includes/css/dist/block-library/…`). It *is* a file, but you must never edit it — core updates replace it. Granularity `file`; the edit surface says so and tells you to override in your theme or Additional CSS instead.

### 4. `core-block-supports-inline-css` — per-block attributes

When you set a color, padding, or font size on an individual block in the editor, WordPress generates a `wp-container-…`/`wp-elements-…` rule into this inline sheet. The origin is the **block's own settings in the post editor** — open the post, select the block, change the attribute.

### 5. `{handle}-inline-css` — `wp_add_inline_style()`

Any theme or plugin can attach extra CSS to a registered stylesheet handle; WordPress prints it as `<style id="{handle}-inline-css">`. Typical sources: theme-options pages ("pick your accent color"), plugin settings that emit CSS. Visionaire names the handle — e.g. `inline CSS for handle 'astra-theme'` — which tells you *whose* settings page to look in. (Which plugin registered the handle isn't knowable from the page alone; see [limitations](#honest-limitations-convention-mode).)

### 6. `uploads/elementor/css/post-{id}.css` — Elementor per-page CSS

Elementor compiles every page's widget settings (stored in the `_elementor_data` post meta) into one generated file per post. The file is real; editing it is futile. Visionaire extracts the **post id from the URL** and — when the matched rule's selector contains `.elementor-element-{id}` (winner or loser alike) — the **widget id** too:

```
[db-entity | Elementor (post 88) — Elementor editor for post 88 > widget 4f2a1c]
```

With a widget id the answer is precise enough to act on (`db-entity`). Without one (e.g. a page-level Elementor rule, or `page_origins`, which classifies whole sheets and has no selector to inspect) the honest label is `generated`.

To find the widget on canvas: open the page in Elementor and use the Navigator, or note that the element carries the class `elementor-element-4f2a1c` in the DOM.

### 7. `uploads/elementor/css/global.css` — Elementor Site Settings

Elementor's site-wide kit (global colors, fonts, buttons). Edit in **Elementor → Site Settings**, not the file. `db-entity`.

### 8. `/et-cache/` — Divi generated CSS

Divi (Elegant Themes) compiles builder output into `wp-content/et-cache/…`. Same deal as Elementor: `generated`, and the edit surface points you to the Divi builder for that post — with a reminder to rebuild the et-cache after editing (clear Divi's static CSS cache in Theme Options if a stale file sticks around).

### 9. Optimizer bundles — see [the dedicated section below](#optimizer-bundles-and-bypass-hints)

### 10–11. Theme and plugin files — the happy path

`/wp-content/themes/{slug}/…` and `/wp-content/plugins/{slug}/…` are classic served-file-IS-the-editable-file WordPress. Granularity `line`: visionaire gives you the file path relative from `wp-content/` plus the 1-based line number of the declaration:

```
→ themes/astra/style.css:8  [line | theme: astra — edit themes/astra/style.css]
```

For plugins the edit surface adds a warning — `(plugin updates overwrite — prefer overriding)` — because your edit dies on the next plugin update; override from the (child) theme or Additional CSS instead.

**Minified files degrade honestly.** When the served theme/plugin file is minified (`.min.` in the filename, or a large sheet packed into very few lines) and carries no source map, a line number into it would be meaningless — so the granularity degrades from `line` to `file`, no line number is printed, and the bracket says why:

```
→ plugins/elementor/assets/css/frontend.min.css  [file | plugin: elementor — minified, no map]
```

A minified sheet *with* a source map keeps `line` granularity — the map resolves declarations back to their authored positions.

A child theme is just another theme slug here: rule-level attribution reports `theme: astra-child` with the concrete file path. Telling parent from child happens only at page level, in `detectPlatform()` (see [below](#platform-detection-in-page_origins)).

These rules run *last* so that generated URLs (Elementor, et-cache, optimizer caches) never get misclassified as innocent files.

---

## Optimizer bundles and bypass hints

Performance plugins concatenate and minify all page CSS into cache files. Visionaire recognizes:

| URL pattern | Optimizer | Bypass hint emitted |
|---|---|---|
| `/wp-content/cache/autoptimize/…` | Autoptimize | `?ao_noptimize=1` |
| `/cache/wp-rocket/…` | WP Rocket | `?nowprocket` |
| `/cache/min/…` (WP Rocket's minify cache) | WP Rocket | `?nowprocket` |

A rule attributed to a bundle looks like:

```
[generated | optimizer bundle — generated bundle — re-inspect with bypass query param ?nowprocket]
```

**The workflow:** `navigate` to the same URL with the bypass param appended (`https://site.com/page/?nowprocket`), then re-run `explain_styles`. With the optimizer out of the way, the same rules resolve to their true origins — theme file, plugin file, Elementor post, whatever they really are. The `page_origins` platform line warns you up front (`optimizers: wp-rocket`), so an agent should bypass *before* investing in a deep debugging session.

**Why "Remove Unused CSS" features often CAUSE the bug you're debugging.** WP Rocket's RUCSS (and similar "unused CSS" removal in other optimizers) crawls the page once, keeps only the selectors it saw matching, and throws the rest away. Anything that appears *later* — classes toggled by JavaScript, hover/open states, other viewports, logged-in-only markup — loses its CSS. The symptom is "this element is unstyled/broken, but the rule exists in my theme file." Both statements are true: the rule exists in the source and is absent from the served bundle. Comparing `explain_styles` output with and without the bypass param makes this class of bug directly visible — a rule that wins with `?nowprocket` and doesn't exist without it was eaten by the optimizer, and the fix is an RUCSS exclusion, not a CSS change.

---

## Platform detection in `page_origins`

`page_origins {}` ends with a one-line platform summary produced by `detectPlatform()`:

```
platform: WordPress 6.9 | theme: astra | builders: elementor | optimizers: none detected
```

How each piece is decided (all from the rendered page, no WP cooperation):

- **Is it WordPress?** Any stylesheet URL containing `/wp-content/` or `/wp-includes/`, **or** a `<meta name="generator">` mentioning WordPress, **or** the body classes `elementor-page` / `et_divi_theme`. If none match, the line reads `platform: not WordPress (…)`.
- **Version** — parsed from the generator meta (`WordPress 6.9` → `6.9`). Sites that strip the generator tag simply get no version.
- **Theme (and child theme)** — collected from `/wp-content/themes/{slug}/` URLs. One slug → that's the theme. Two or more slugs → a parent/child pair must be told apart, which sheet counts alone can't do; the heuristic: a slug containing `-child` is the child; otherwise the slug serving `style.css` directly at the theme root (the child-theme convention) is the child; otherwise the slug with fewer stylesheets is *assumed* to be the child. Output: `theme: astra (child: astra-child)`.
- **Builders** — `elementor` if any Elementor CSS URL (`post-{id}.css`, `global.css`, `/plugins/elementor/`) or the `elementor-page` body class is present; `divi` if `/et-cache/`, `/themes/Divi/`, or the `et_divi_theme` body class is present.
- **Optimizers** — the same URL patterns as the bundle rules above.

---

## Worked example

### A. Bundled fixture (no network needed)

The repo ships a miniature WordPress page — `test/fixtures/wordpress.html` — with a theme stylesheet, a plugin stylesheet, an Elementor `post-88.css`, and real `wp-custom-css` / `global-styles-inline-css` blocks. Run the demo against it (the demo prints `page_snapshot` + `explain_styles`; call `page_origins` from your MCP client):

```bash
npm run demo -- "file://$PWD/test/fixtures/wordpress.html" --selector ".elementor-element-4f2a1c"
```

`page_origins {}` on this page classifies every sheet and detects the platform:

```
stylesheets on file:///…/test/fixtures/wordpress.html: 5 total (3 files, 2 inline, 0 user-agent/constructed)
themes/astra/style.css — 0.3 KB [line | theme: astra]
uploads/elementor/css/post-88.css — 0.2 KB [generated | Elementor (post 88)]
plugins/myplugin/style.css — 0.1 KB [line | plugin: myplugin]
<style#global-styles-inline-css> — 0.1 KB [db-entity | Global Styles]
<style#wp-custom-css> — 0.0 KB [db-entity | Customizer > Additional CSS]

platform: WordPress 6.9 | theme: astra | builders: elementor | optimizers: none detected
```

`explain_styles` on the Elementor widget shows the theme and the builder fighting over `margin-bottom` — and resolves each side to its real edit surface, including the extracted widget id:

```
element e4 <div.elementor-element.elementor-element-4f2a1c.elementor-widget>
why margin-bottom = 30px:
  WINNER  .elementor-element-4f2a1c { margin-bottom: 30px }  spec(0,1,0)
    → uploads/elementor/css/post-88.css  [db-entity | Elementor (post 88) — Elementor editor for post 88 > widget 4f2a1c]
  lost (order)  .elementor-widget { margin-bottom: 20px }  spec(0,1,0)
    → themes/astra/style.css:8  [line | theme: astra — edit themes/astra/style.css]
…
```

Read it like this: the widget's margin comes from Elementor — go to the Elementor editor for post 88, widget `4f2a1c` (Advanced → Margin), not to the generated file. The theme's `20px` lost on source order; if you *wanted* the theme to win you now know exactly which two rules are competing and why.

And a Customizer hit, from `--selector ".site-footer"`:

```
why letter-spacing = 0.5px:
  WINNER  .site-footer { letter-spacing: 0.5px }  spec(0,1,0)
    → …/test/fixtures/wordpress.html:2  [db-entity | Customizer > Additional CSS — Appearance → Customize → Additional CSS (stored as custom_css post)]
```

No grep of the theme folder would ever have found that rule — it lives in the database.

### B. Live site: wordpress.org

```bash
npm run demo -- https://wordpress.org/ --selector "h1"
```

`page_origins {}` against the real thing (trimmed — the full inventory lists 35 sheets):

```
stylesheets on https://wordpress.org/: 35 total (14 files, 20 inline, 1 user-agent/constructed)
https://wordpress.org/wp-content/mu-plugins/pub-sync/global-fonts/NotoSerif/NotoSerifSC/style.css — 114 KB [line | wordpress.org]
themes/wporg-main-2022/build/style/style-index.css — 98.8 KB [line | theme: wporg-main-2022]
themes/wporg-parent-2021/build/style.css — 66.1 KB [line | theme: wporg-parent-2021]
plugins/gutenberg/build/styles/block-library/navigation/style.min.css — 20.3 KB [file | plugin: gutenberg]
…
<style#global-styles-inline-css> — 35.9 KB [db-entity | Global Styles]
<style#core-block-supports-inline-css> — 4.4 KB [db-entity | block supports CSS]
<style#wp-block-image-inline-css> — 8.7 KB [db-entity | inline CSS for handle 'wp-block-image']
<style#wporg-latest-news-style-inline-css> — 3.6 KB [db-entity | inline CSS for handle 'wporg-latest-news-style']
…
plus 1 constructed sheet(s) — not editable page files

platform: WordPress 7.1-alpha-62617 | theme: wporg-parent-2021 (child: wporg-main-2022) | builders: none detected | optimizers: none detected
```

Note the parent/child call: neither slug contains `-child`, yet the heuristic correctly identifies `wporg-main-2022` as the child of `wporg-parent-2021`. The version string is real too — wordpress.org runs trunk. (Also visible: `mu-plugins` isn't one of the URL patterns, so those sheets get the generic `[line | wordpress.org]` host label rather than a WordPress-specific one — still a real, editable file path.)

`explain_styles { selector: "h1" }` on a block theme shows how much of modern WordPress styling is Global Styles, i.e. database, not files (trimmed):

```
element e146 <h1.wp-block-heading> "Meet WordPress"
why margin-block-start = 0px:
  WINNER  :root :where(.wp-block-column-is-layout-flow) > :first-child { margin-block-start: 0 }  spec(0,2,0)
    → global-styles-inline-css:6  [db-entity | Global Styles — Site Editor → Styles (theme.json / wp_global_styles)]
  lost (order)  :root :where(.is-layout-flow) > :first-child { margin-block-start: 0 }  spec(0,2,0)
    → global-styles-inline-css:2  [db-entity | Global Styles — Site Editor → Styles (theme.json / wp_global_styles)]
  …
  lost (origin)  h1 { margin-block-start: 0.67em }  spec(0,0,1)
    → user-agent stylesheet
why font-size = 70px:
  WINNER  inline style attribute
  lost (inline)  h1 { font-size: var(--wp--preset--font-size--heading-1) }  spec(0,0,1)
    → global-styles-inline-css:2  [db-entity | Global Styles — Site Editor → Styles (theme.json / wp_global_styles)]
  …
```

### How an agent should use this

1. `connect { url }` → `page_origins {}` first. The platform line sets strategy: is it WordPress, which theme/builder, **is an optimizer in the way**.
2. If `optimizers:` names one, `navigate` to the URL with the bypass param before deep debugging.
3. `page_snapshot` / `find_elements` to locate the element, then `explain_styles`.
4. Trust the bracket. `[line | …]` → edit that file:line. `[db-entity | …]` → the edit surface names the admin screen or builder control; **do not** edit the file in the location line. `[generated | …]` → never edit; follow the hint to the true source.
5. To verify a fix, `style_diff { mode: 'record' }` → apply the change → `style_diff { mode: 'compare' }`.

---

## Honest limitations (convention mode)

Zero-cooperation detection is deliberately honest about where it stops:

- **Elementor: widget, yes — control, no.** `.elementor-element-4f2a1c` gives the widget id, and the URL gives the post id, but *which control* (Style → Text Color? Advanced → Padding?) lives in the `_elementor_data` post meta, which the rendered page doesn't expose. The edit surface stops at "Elementor editor for post 88 > widget 4f2a1c".
- **Stale generated CSS is invisible.** If `post-{id}.css` or `et-cache` output is out of date relative to the current builder settings (a classic "my change doesn't show" cause — fixed by Elementor's Regenerate CSS or clearing the Divi cache), convention mode can't tell: it sees only the served file, not the database it was compiled from.
- **Site Editor template overrides are invisible.** When a template or template part has been customized in the Site Editor, the live markup comes from a `wp_template`/`wp_template_part` post — but stylesheet attribution will still point at theme files/`theme.json` with no hint that a database override is in play.
- **`{handle}-inline-css` names the handle, not the owner.** Knowing the handle is `astra-theme` strongly suggests where to look, but the page can't prove which plugin/theme registered it or which option prints it.
- **Optimizer coverage is WP Rocket + Autoptimize.** Other optimizers' bundles (LiteSpeed Cache, SiteGround Optimizer, W3 Total Cache, …) don't match the v0.1 patterns and fall through to generic file classification — you'd get a `[line | …]` pointer into a cache file. Watch the URL: anything under a `cache/` path is suspect.
- **The parent/child theme heuristic can guess wrong** when neither the `-child` slug convention nor a direct root `style.css` tells the two slugs apart — it then assumes the theme with fewer stylesheets is the child. Rule-level attribution sidesteps this by always labeling `theme: {slug}` with the concrete file path.
- **`mu-plugins` has no dedicated rule.** Must-use plugin stylesheets (`/wp-content/mu-plugins/…`) get the generic host-label classification, not a `plugin:` label. The file path is still correct and editable.

**The v1.1 plan lifts the big ones.** [development.md](development.md)'s roadmap sketches a WordPress companion plugin (~6 Abilities on the official mcp-adapter, WP 6.9+) that adds exactly what convention mode can't see: the enqueue registry (handle → owner), `_elementor_data` resolution (widget id → the named control), Site-Editor template-override detection, and staleness checks for generated CSS. Convention mode stays the zero-install default; the plugin upgrades granularity when present.
