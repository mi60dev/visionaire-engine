# Tool reference

Visionaire Engine exposes 13 MCP tools: three session tools (`connect`, `navigate`, `set_viewport`) and ten inspection tools. All output is plain text (plus one PNG for `annotated_screenshot`), deterministic, and token-budgeted. Concepts and vocabulary come from [../SPEC.md](../SPEC.md); this page documents the tools as implemented.

## Targeting elements

Every element-taking tool accepts a **TargetSpec**: exactly one of

| Field | Meaning |
|---|---|
| `uid` | Element uid from any earlier tool output, e.g. `"e8"` |
| `selector` | CSS selector — the **first** match is used |
| `x` + `y` | Viewport coordinates in CSS px (both required together) |

Passing zero or more than one of these fails with `Provide exactly one of: uid, selector, or x+y coordinates.`

**Uid semantics.** Uids are `e`-prefixed integers (`e1`, `e2`, …) assigned at first sight and keyed by the node's CDP `backendNodeId`. The same DOM node gets the same uid from every tool — `page_snapshot`, `find_elements`, `inspect_ancestors`, visibility causes, `node_at_point` chains — for the lifetime of the page. Mark numbers in `annotated_screenshot` are the uid digits (mark `17` = uid `e17`). Navigation clears the registry: after `navigate` (or any navigation the page initiates itself, like a JS redirect), all previous uids are stale and tools answer with an actionable error (`Unknown uid "e8" — it may be stale after navigation. Take a fresh page_snapshot.`). Numbering restarts at `e1`, so `e1` is simply the first node any tool touched after the last navigation — not necessarily `<body>`.

**Coordinate systems.** `x`/`y` targeting, `find_elements` results, `node_at_point`, and `annotated_screenshot` regions/legends all use **viewport** coordinates. `page_snapshot` geometry comes from the DOM snapshot and is in **document** coordinates (identical to viewport coordinates when the page is not scrolled).

Tool errors come back as MCP text results prefixed `Error: `, e.g. `Error: No element matches selector: .does-not-exist`.

---

## connect

Start (or restart) the browser session. Launches a local Chrome by default (found via the `CHROME_PATH` env var or standard install locations), or attaches to a Chrome you already run with `--remote-debugging-port` — attach mode is how you inspect pages behind logins, since it reuses your real profile and cookies. Call this before any other tool; re-calling `connect` tears down the previous session. Pass `url` to navigate immediately.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `mode` | `'launch' \| 'attach'` | `'launch'` (`'attach'` inferred when `browserUrl` is set) | `attach` joins a running Chrome |
| `url` | string | — | Navigate here right after connecting |
| `browserUrl` | string | — | DevTools HTTP endpoint for attach mode, e.g. `http://127.0.0.1:9222` |
| `headless` | boolean | `false` | Launch mode only; `false` opens a visible window |
| `width` | integer > 0 | `1280` | Viewport width. In attach mode the real window size is kept unless width/height are passed explicitly |
| `height` | integer > 0 | `800` | Viewport height |

**Output** — one status line with mode, browser version, viewport, and current URL:

```
connected (launch) — Chrome/149.0.7827.201 — viewport 1280x800
url: file:///…/test/fixtures/cascade.html
```

## navigate

Load a URL in the connected tab (waits for the `load` event). All uids from earlier snapshots become stale, and the stylesheet registry is rebuilt for the new document.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `url` | string | required | Absolute URL to load |

**Output:**

```
navigated to file:///…/test/fixtures/wordpress.html — previous uids are stale; take a fresh page_snapshot.
```

## set_viewport

Emulate a viewport size on the connected tab for responsive debugging. After resizing, re-inspect: media-query winners may change, so earlier `explain_styles` verdicts can be outdated even though uids stay valid.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `width` | integer > 0 | required | Viewport width in CSS px |
| `height` | integer > 0 | required | Viewport height in CSS px |
| `deviceScaleFactor` | number > 0 | `1` | Device pixel ratio to emulate |

**Output:**

```
viewport set to 390x844@1x
```

---

## page_snapshot

The pass-1 census: a pruned, nested tree of the rendered page with stable uids, geometry, visibility, and layout hints. This is the orientation tool — call it first after connecting or navigating; every uid it prints feeds all other tools. It is cheap (one CDP `DOMSnapshot.captureSnapshot`) and token-budgeted, so it is safe to call repeatedly.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `budgetTokens` | integer > 0 | `1500` | Output token budget; pruning kicks in above it |
| `scope` | TargetSpec object | whole page (from `<body>`) | Limit the census to one subtree; exactly one of `uid` \| `selector` \| `x`+`y` |
| `includeInvisible` | boolean | `false` | Render invisible nodes inline with their reason instead of collapsing them into count brackets |

**Output** — one header line, then one line per element. Real output (visibility fixture):

```
page: file:///…/test/fixtures/visibility.html "Visibility fixture"  viewport 1280x800
e1 body 1280x72
  e2 div#normal.case "plainly visible" 200x24 @(0,0)
  e8 div#op0.case "opacity zero" 200x24 @(0,48)
  e11 button#covered "Click me" 120x40 @(100,300) absolute
  e12 div#overlay 200x100 @(80,280) fixed z:10
  [6 invisible nodes hidden: e3(display:none) e4(display:none) e6(visibility:hidden) e7(zero-size) e9(off-viewport) e10(off-viewport)]
```

The same page with `includeInvisible: true` renders the hidden nodes inline:

```
  e3 div#dn-self.case "display:none on self" [display:none]
  e4 div#dn-ancestor.case [display:none]
    e5 p#dn-child "child of a display:none ances…" [display:none]
  e9 div#off-left.case "off-screen to the left" 200x24 @(-9999,0) absolute [off-viewport]
```

### Census notation

- **Indentation** (two spaces per level) is DOM hierarchy. Non-rendering elements (`script`, `style`, `head`, `link`, `meta`, …) and pseudo-elements are excluded entirely.
- **Node line**: `uid tag#id.class1.class2.class3 "text…" WxH @(x,y) hints`. At most 3 classes; text is the element's own text nodes, truncated at 30 chars with `…`. Coordinates are document coordinates; the root line omits `@(x,y)`.
- **Layout hints** appear only when noteworthy: display `flex` / `grid` / `inline-flex` / `inline-grid`, position `sticky` / `fixed` / `absolute`, and `z:N` when `z-index` is set on a non-static element.
- **Invisible nodes** are hidden by default but counted with pass-1 reasons in a bracket line rendered among their parent's children: `[6 invisible nodes hidden: e3(display:none) …]`. Pass-1 reasons are the cheap checks only — `display:none`, `visibility:hidden`, `zero-size`, `off-viewport`. For the full causal verdict (clipped, occluded, opacity chain, who caused it) run `inspect_element` on the uid.
- **Pruning markers** appear when output exceeds `budgetTokens`, in order: (1) invisible-bracket detail is dropped (`[6 invisible nodes hidden]` with no uids), (2) chains of single-child wrapper `div`/`span` with no id, ≤ 1 class, no layout hint, and no text are spliced out, (3) the deepest tree level is truncated repeatedly. Nodes that lost children get `[N pruned]` — or `[N links]` when everything pruned under them was `<a>` elements — and the census ends with a footer:

```
e1 body 1280x72 [4 pruned]
  [6 invisible nodes hidden]
  [4 nodes pruned: budget — narrow with scope or find_elements]
```

- **Iframes** are not descended into; a trailing `[N iframe document(s) not included — v0.1 snapshots the main document only]` marker tells you they exist. Scoping to a node inside an iframe fails with an explicit error.

When platform detection (the same detection `page_origins` uses) finds something, the census header ends with a platform suffix — `page: https://example.com "Example"  viewport 1280x800  (WordPress 6.9, theme astra, builder elementor)`. Pages with no platform markers get no suffix. For the stylesheet-level breakdown, use `page_origins`.

## page_origins

Inventory of every stylesheet on the page plus platform detection. Reach for it before proposing edits: it tells you where the CSS comes from (theme file? plugin? Elementor-generated? Customizer database entry?) and whether WordPress, page builders, or CSS optimizers are in play. Detection is convention-based (URL patterns like `/wp-content/themes/{slug}/`, owner `<style id="…">` handles, generator meta, body classes) and needs zero cooperation from the site.

No parameters.

**Output** — a count header; one line per external sheet (largest first) with size, honesty-ladder classification, and source-map presence; inline `<style>` sheets (named ones by owner id, anonymous ones collapsed to a single `<style> ×N` line); a tail line counting user-agent/constructed/injected sheets; and a platform summary. Real output (WordPress fixture):

```
stylesheets on file:///…/test/fixtures/wordpress.html: 5 total (3 files, 2 inline, 0 user-agent/constructed)
themes/astra/style.css — 0.3 KB [line | theme: astra]
uploads/elementor/css/post-88.css — 0.2 KB [generated | Elementor (post 88)]
plugins/myplugin/style.css — 0.1 KB [line | plugin: myplugin]
<style#global-styles-inline-css> — 0.1 KB [db-entity | Global Styles]
<style#wp-custom-css> — 0.0 KB [db-entity | Customizer > Additional CSS]

platform: WordPress 6.9 | theme: astra | builders: elementor | optimizers: none detected
```

External sheets carry `(source map)` when a `sourceMapURL` is present. Sizes are bytes served, not rule counts. When an optimizer bundle (WP Rocket, Autoptimize) is detected, its classification includes a bypass hint (e.g. re-inspect with `?nowprocket`) so you can attribute against the original files. Output is capped at ~1800 tokens; the smallest file sheets are dropped first with an `[N more file stylesheets omitted for budget — smallest last]` marker. Non-WordPress pages end with `platform: not WordPress (no /wp-content/, /wp-includes/, or generator markers)`.

## inspect_element

The "what" dossier for one element: box model, whitelisted computed styles, visibility verdict with cause, and layout context. Use it when you need an element's current rendered state — is it visible, what size is it really, is it a flex item. For *why* it has those values, use `explain_styles`.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `uid` / `selector` / `x`+`y` | TargetSpec | required (one) | Which element |
| `verbose` | boolean | `false` | Include all ~55 whitelisted computed properties; by default properties sitting at their no-op value (`position: static`, `margin-top: 0px`, `opacity: 1`, …) are dropped, while `display`, `width`, `height`, `font-size`, `font-family`, `color` are always shown |

**Output** — real example (cascade fixture, the inline-level button with an inactive `width: 100%`):

```
element e5 <a.btn> "Get started"  — visible
box: content 90.2x18 @(68,153.9) | padding 12 28 12 28 | border 0 | margin 0
layout: inline (parent e2: block)
computed (authored-relevant):
  display: inline | width: 100% → 90.2px | height: auto → 18px | margin-bottom: 24px
  padding-top: 12px | padding-right: 28px | padding-bottom: 12px | padding-left: 28px
  font-size: 16px | font-family: sans-serif | color: rgb(255, 255, 255)
  background-color: rgb(108, 92, 231)
visibility: visible — paints on top at center
```

- `box:` — content-box size and position, then padding / border / margin as `top right bottom left` (collapsed to one number when all four are equal).
- `layout:` — own display plus the parent's uid and display; flex/grid parents add `; flex item` / `; grid item`.
- `width` and `height` are shown as `computed → used` pairs when the computed value differs from the real content-box size (`width: 100% → 90.2px`); other properties show the computed value only.
- `visibility:` — one of `visible`, `detached`, `display-none`, `visibility-hidden`, `zero-size`, `opacity-zero`, `off-viewport`, `clipped`, `occluded`, `transparent-text`, with a causal sentence naming the responsible ancestor/occluder uid and, for `display:none`, the rule that set it. Two real examples:

```
visibility: display-none — ancestor e2 has display:none (set by inline style)
notes:
  - no box model — element is not rendered
```

```
visibility: occluded — occluded by e4 <div> — 5/5 probes hit it
```

## explain_styles

The wedge. Explains WHY an element looks the way it does: a per-property cascade verdict naming the winning declaration and every loser with the reason it lost, each mapped to its editable origin — file:line, WordPress database entity, or builder control. This is the tool that answers "which rule do I edit". Without `property` it covers every property that has competing declarations or an authored (non-user-agent) winner, ordered by contention (most competing declarations first), capped at an ~800-token dossier. With `property` it explains that property and its shorthand family, never truncated.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `uid` / `selector` / `x`+`y` | TargetSpec | required (one) | Which element |
| `property` | string | all competing/authored properties | CSS property to focus on. Shorthands expand to their family (`margin` → all four `margin-*`); a longhand also pulls in verdicts whose candidates were expanded from a covering shorthand |

**Output** — a full real dossier, captured with `npm run demo` (cascade fixture, `.hero-cta .btn`):

```
element e5 <a.btn> "Get started"
why color = rgb(255, 255, 255):
  WINNER  inline style attribute
  lost (inline)  .hero-cta .btn { color: #eeeeee }  spec(0,2,0)
    → …/fixtures/css/theme.css:12  [line — edit this file]
  lost (origin)  a:-webkit-any-link { color: -webkit-link }  spec(0,1,1)
    → user-agent stylesheet
why letter-spacing = 1px:
  WINNER  .btn { letter-spacing: 1px !important }  spec(0,1,0)
    → …/fixtures/css/plugin.css:7  [line — edit this file]
  lost (importance)  .hero-cta .btn { letter-spacing: 2px }  spec(0,2,0)
    → …/fixtures/css/theme.css:16  [line — edit this file]
why margin-bottom = 24px:
  WINNER  .hero-cta .btn { margin-bottom: 24px }  spec(0,2,0)
    → …/fixtures/css/theme.css:10  [line — edit this file]
  lost (specificity)  .btn { margin-bottom: 12px }  spec(0,1,0)
    → …/fixtures/css/plugin.css:5  [line — edit this file]
…
why text-decoration-line = none:
  WINNER  .btn { text-decoration-line: none } (from text-decoration)  spec(0,1,0)
    → …/fixtures/css/plugin.css:4  [line — edit this file]
  lost (origin)  a:-webkit-any-link { text-decoration-line: underline }  spec(0,1,1)
    → user-agent stylesheet
…
why font-family = sans-serif:
  WINNER  body { font-family: sans-serif }  inherited from ancestor
    → …/fixtures/css/theme.css:5  [line — edit this file]
why outline-color = rgb(18, 52, 86):
  WINNER  .hero-cta .btn { outline-color: #123456 }  spec(0,2,0)
    → …/fixtures/css/theme.css:23  [line — edit this file]
why padding-bottom = 12px:
  WINNER  .btn { padding-bottom: 12px } (from padding)  spec(0,1,0)
    → …/fixtures/css/plugin.css:4  [line — edit this file]
[4 more properties — ask with property:]
notes:
  - 'margin-bottom: 24px' at theme.css:10 is INACTIVE — vertical 'margin-bottom' has no effect on a non-replaced inline element; add display:block or display:inline-block
  - 'width: 100%' at theme.css:14 is INACTIVE — 'width' has no effect on a non-replaced inline element; add display:block or display:inline-block
  - winner for outline-color sits inside @layer fixture
```

And a WordPress example (Elementor widget, `property: "margin-bottom"`) showing db-entity attribution:

```
element e4 <div.elementor-element.elementor-element-4f2a1c.elementor-widget>
why margin-bottom = 30px:
  WINNER  .elementor-element-4f2a1c { margin-bottom: 30px }  spec(0,1,0)
    → uploads/elementor/css/post-88.css  [db-entity | Elementor (post 88) — Elementor editor for post 88 > widget 4f2a1c]
  lost (order)  .elementor-widget { margin-bottom: 20px }  spec(0,1,0)
    → themes/astra/style.css:8  [line | theme: astra — edit themes/astra/style.css]
```

### Reading the dossier — full legend

**`why <property> = <value>:`** — one block per longhand property; the value is the live computed value from the browser, so it always reflects reality even if the verdict is uncertain.

**`WINNER`** — the declaration that wins the cascade. Rule winners show `selector { property: value }`; the other origins render as `inline style attribute` or `element attribute style`. `(from <shorthand>)` marks a longhand expanded from a shorthand declaration (`{ padding-bottom: 12px } (from padding)`). `inherited from ancestor` / `inherited from e12 <div.card>` marks values that arrived by inheritance rather than a direct match.

**`lost (<reason>)`** — each losing declaration on one line, tagged with the *first decisive* reason it lost:

| Reason | Meaning |
|---|---|
| `importance` | A `!important` declaration beat it |
| `specificity` | Lower selector specificity than the winner |
| `order` | Equal footing, but the winner appears later in source order |
| `layer` | Lost on `@layer` ordering (unlayered author CSS beats layered for normal declarations; reversed under `!important`) |
| `origin` | Lost on cascade origin — typically a user-agent rule beaten by author CSS |
| `inline` | The element's inline `style=""` attribute beat it |
| `inherited-distance` | An inherited candidate beaten by a nearer ancestor's value (any direct match beats any inherited one) |

**`spec(a,b,c)`** — the matched selector's specificity: `a` = id selectors, `b` = classes/attributes/pseudo-classes, `c` = type selectors/pseudo-elements. Omitted for inline, attribute, and inherited entries, where specificity is not what decides.

**`→ location`** — where the declaration physically lives, best-honest first: source-mapped authored position (`src/components/hero.scss:42 (via source map)`) > attributed file:line > the served sheet URL trimmed to its last 3 path segments with a leading `…/` > `<inline>` for `<style>` elements > `user-agent stylesheet`. Line numbers are 1-based. When the granularity is `file` (e.g. a minified sheet with no source map — bracket reads `minified, no map` — or a source map that exists but failed to resolve) no line number is printed rather than printing a wrong one.

**`[granularity | label — edit hint]`** — the honesty-ladder bracket after the location. Granularity is one of `line` > `file` > `db-entity` > `component` > `generated` > `unknown` (see [../SPEC.md](../SPEC.md) §5.2). The label names the origin (`theme: astra`, `plugin: myplugin`, `Elementor (post 88)`, `Customizer > Additional CSS`); the part after `—` is the actionable edit surface (`edit this file`, `Elementor editor for post 88 > widget 4f2a1c`, `generated bundle — re-inspect with bypass query param ?nowprocket`). Label and hint are omitted when they add nothing; a sheet-backed rule that could not be classified still gets a bare `[unknown]` plus its selector and declaration text — never silence.

**`no authored declaration — value comes from browser defaults or inheritance`** — returned for a `property:` filter that matched nothing authored:

```
element e2 <div#promo-banner>
why color = rgb(0, 0, 0):
  no authored declaration — value comes from browser defaults or inheritance
```

**`visibility:` line** — inserted directly under the element header *only when the element is not visible*, because that changes how to read everything below:

```
element e1 <p#dn-child>
visibility: display-none — ancestor e2 has display:none (set by inline style)
```

**`INACTIVE` notes** — winning declarations that have no effect ("you set it, but…"), from a closed ruleset (width/height on inline elements, flex-item props without a flex parent, `z-index` on `position: static`, `top/left` on static, `text-overflow` without `overflow:hidden` + `nowrap`, and more — SPEC §6.3). Each note gives the declaration, its short location, the reason, and a fix hint:

```
- 'z-index: 9999' at theme.css:18 is INACTIVE — 'z-index' has no effect on a position:static element that is not a flex or grid item; add position:relative (or absolute/fixed/sticky)
```

**Other notes** — `winner for X sits inside @media (min-width: 768px)` / `… inside @layer fixture` (the winning rule's conditional context); `verdict-uncertain (computed disagrees) for X: predicted '…', computed '…'` (the engine never silently guesses — SPEC §9); `@keyframes present (name) — animated values are not modeled in v0.1; verdicts reflect the static cascade`.

**`[N more properties — ask with property:]`** — the dossier hit its ~800-token budget; the remaining, less-contended properties were dropped. Re-ask with `property:` for any of them (property-filtered calls are never truncated).

## inspect_ancestors

Walk the ancestor chain (self → root) for one concern, printing one compact line per ancestor with only the concern-relevant computed properties and flagging the **binding constraint** — the nearest ancestor that actually limits the element. Use it when an element is sized, clipped, positioned, or stacked by something above it and you need to know *which* ancestor. Every line carries a uid, so you can drill into any hop with `explain_styles`.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `uid` / `selector` / `x`+`y` | TargetSpec | required (one) | Which element |
| `concern` | `'width' \| 'height' \| 'position' \| 'overflow' \| 'stacking'` | `'width'` | Which constraint chain to report |

Per concern the summary shows: **width/height** — `width`/`max-width`/`min-width`, `box-sizing`, paddings, non-block display, `flex-basis` for flex items, explicit inline `style="width: …"`; **position** — `position`, non-auto insets, `z-index`, and `transform:set (containing block)` (a transformed ancestor is the containing block even for `position:fixed`); **overflow** — `overflow`, `clip-path`, `contain`, `content-visibility`; **stacking** — `z-index`, `position`, and the stacking-context creator reason per SPEC §6.4.

**Output** — real examples:

```
ancestors of e5 <a.btn> — concern: width (self → root)
e5 <a.btn> width:100% padding-x:28px display:inline
e2 <section.hero-cta> width:1200px padding-x:40px
e1 <body> width:1280px
e7 <html> width:1280px
```

```
ancestors of e1 <div#promo-banner> — concern: stacking (self → root)
e1 <div#promo-banner> z-index:9999
e2 <body> z-index:auto
e3 <html> z-index:auto root stacking context [BINDING]
```

Identity lines follow the same `<tag#id.classes>` format as the other tools: the `#id` when the element has one, then up to 3 classes. `[BINDING]` marks the nearest qualifying *ancestor* (never the element itself). For `concern: 'stacking'`, when the element has a numeric z-index and its nearest stacking context is not the root, a closing note explains the trap: `note: z-index:9999 is scoped inside context created by e12 (transform) — it cannot escape that context`. Very deep chains are pruned to ~800 tokens, keeping self, the nearest ancestors, and always the root line, with `[N more ancestors pruned]`.

## find_elements

Deterministic page search — the grounding tool for "the button under the hero". Criteria are AND-combined; matching is exact and rule-based (no fuzzy matching — that stays with the calling LLM, which can search several times cheaply). Text matching is a case-insensitive substring test on normalized `innerText`, preferring elements whose *own* text nodes contain the needle and otherwise keeping only the deepest matches so wrappers do not shadow the real hit.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `text` | string | — | Case-insensitive substring of the element's own text |
| `selector` | string | — | CSS selector, matched via `querySelectorAll` |
| `role` | string | — | ARIA role: explicit `[role]` attribute or tag-implied (`link`, `button`, `heading`, `navigation`, `textbox`, `list`, …) |
| `region` | `{x, y, width, height}` | — | Viewport rectangle (CSS px) the element must intersect |
| `visibleOnly` | boolean | `true` | Drop elements hidden by display/visibility/opacity |
| `limit` | integer 1–100 | `10` | Maximum matches returned |

At least one of `text` / `selector` / `role` / `region` is required.

**Output** — a count header plus one compact line per match, in viewport coordinates:

```
1 element found:
e5 <a.btn> "Get started" 146x42 @(40,142)
```

When more matched than were shown: `27 elements found — showing first 10 (raise limit or narrow criteria):`. When nothing matched: `no elements matched (criteria are AND-combined; try visibleOnly: false or fewer criteria)`.

## node_at_point

Ground a viewport coordinate — typically a spot in a screenshot — to a concrete element: uid, one-line identity, and the full ancestor uid chain so you can move up when the hit is a text wrapper or an icon inside the thing you actually meant.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `x` | number | required | Viewport x in CSS px |
| `y` | number | required | Viewport y in CSS px |

**Output:**

```
hit: e5 <a.btn> "Get started" 146x42 @(40,142) — chain: e5 a.btn < e2 section.hero-cta < e1 body
```

Text-node hits resolve to their parent element; the chain escapes shadow roots via the host element. Points outside the viewport fail with `no element at (x, y) — the point may be outside the viewport`.

## annotated_screenshot

A screenshot with numbered marks burned in — the bridge between pixels and uids. **Mark numbers are the uid digits** (mark `5` = uid `e5`), so anything you see in the image can be fed straight into `inspect_element` / `explain_styles`. By default it marks the top ~25 visible interactive/landmark elements (`a`, `button`, `input`, `select`, `textarea`, `nav`, `header`, `footer`, `main`, `h1`–`h3`, `[role="button"]`) within the captured area; pass `uids` to mark exactly the elements you care about. Marks are injected as a temporary overlay and removed after capture.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `uids` | string[] | top ~25 interactive/landmark elements | Uids to mark; unknown/detached uids are skipped and listed |
| `region` | `{x, y, width > 0, height > 0}` | — | Clip to this viewport rectangle (CSS px). Mutually exclusive with `fullPage` |
| `fullPage` | boolean | `false` | Capture the whole document, beyond the viewport |

**Output** — a text legend plus one PNG image content block:

```
annotated screenshot (viewport) — 2 marks; mark number = uid digits (mark 17 = e17)
marks:
  3=e3 <h1> "Build faster" @(40,61)
  5=e5 <a.btn> "Get started" @(40,142)
```

Legend coordinates are viewport coordinates for viewport/region captures and document coordinates for `fullPage` (matching the image pixels). Stale uids append a `skipped: e42 (unknown uid — take a fresh page_snapshot)` line rather than failing the whole call.

## style_diff

Record an element's computed styles and box model into a named slot, then compare later and see **only what changed** — the verify-my-fix loop. Record before your edit, apply the change (edit the file and `navigate` to reload, or mutate styles in the live page), then compare: an empty diff means your change had no effect where you thought it would; a diff full of unrelated properties means it had side effects.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `uid` / `selector` / `x`+`y` | TargetSpec | required on `record`; optional on `compare` | Which element. On `compare`, omit it to reuse the recorded target |
| `mode` | `'record' \| 'compare'` | required | `record`: store a baseline. `compare`: diff against it |
| `slot` | string | `'default'` | Recording slot name; use distinct slots to track several elements at once |

Slots survive navigation: alongside the uid, `record` stores a selector (the one you targeted with, or `#id` if the element has an id) and `compare` re-resolves through it when the uid has gone stale. The baseline is *not* re-recorded on compare — repeated compares keep diffing against the original recording until you `record` again.

**Output** — real record/compare pair (baseline taken, then the fixture button given `display: inline-block; margin-bottom: 8px`):

```
recorded 55 computed properties + box model for e5 under slot 'default'. Make your change, then call style_diff { mode: 'compare', slot: 'default' }.
```

```
style diff (slot 'default') for e5 <a.btn>:
  display: inline → inline-block
  width: 100% → 1200px
  height: auto → 18px
  margin-bottom: 24px → 8px
  box content: 90.2x18 @(68,153.9) → 1200x18 @(68,165.9)
  box margin: 0 → 0 0 8 0
```

Property lines are `prop: old → new` over the ~55-property whitelist; box lines report content/padding/border/margin deltas with a 0.5px epsilon to suppress sub-pixel noise. Nothing changed:

```
no changes — 55 tracked properties and box model match the 'default' recording for e1 <a.btn>.
```

An element that stopped rendering entirely diffs its box away:

```
style diff (slot 'default') for e1 <a.btn>:
  display: inline → none
  box: 90.2x18 @(68,153.9) → (no box — element not rendered)
```

Diffs are capped at ~800 tokens with `[N more changes truncated — budget]`.

## pick_element

Human-in-the-loop grounding with zero extra install: turns on a DevTools-style hover highlight in the connected tab (box-model fills plus the element info tooltip, via `Overlay.setInspectMode`) and waits for the user to click the element that looks wrong. The clicked element comes back as a uid with its identity and full ancestor uid chain, ready for `explain_styles` / `inspect_element`. Use it when the user offers to point at the element ("I'll show you", "let me click it") or when verbal grounding (`find_elements`, screenshots, `node_at_point`) failed to pin down the element. It needs a human looking at a visible browser window — `connect { headless: false }` (the default) or attach mode. Inspect mode is always exited when the tool returns, whether picked, timed out, or errored.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `timeoutSeconds` | number | `60` | How long to wait for the user's click; clamped to 5–600 |

**Output** — real example (cascade fixture, the user clicks the button):

```
picked: e1 <a.btn> "Get started" 146x42 @(40,142)
chain: e1 a.btn < e2 section.hero-cta < e3 body
next: explain_styles { uid: "e1" } or inspect_element { uid: "e1" }
```

The `picked:` line matches the `node_at_point` identity format (uid, tag/id/classes, own-text preview, size and viewport position); the `chain:` hops each carry a uid so you can move up if the user clicked a text wrapper or an icon inside the thing they meant.

When nobody clicks within the timeout, the tool returns a friendly non-error message so you know to re-ask the user rather than retry blindly:

```
no element was picked within 60s — is someone looking at the browser window? Ask the user to click the element that looks wrong, then call pick_element again (raise timeoutSeconds if they need more time).
```

In a headless session the tool still runs (synthetic `Input.dispatchMouseEvent` clicks can pick — that is how it is e2e-tested), but every result is prefixed with a warning line:

```
warning: headless session — no human can see this tab to click in it (synthetic Input.dispatchMouseEvent clicks still work); use connect { headless: false } for a real picker.
```

---

## Recommended debugging flow

1. **`connect`** — `{ url: "https://site.com" }` to launch, or `{ browserUrl: "http://127.0.0.1:9222" }` to attach to the user's real logged-in Chrome. Add `set_viewport` first thing if the bug is viewport-specific.
2. **Orient: `page_snapshot`** — get the uid-keyed tree. If the user described an element in words, ground it with **`find_elements`** (`{ text: "Get started" }`); if you are working from a screenshot or a coordinate, use **`annotated_screenshot`** / **`node_at_point`**; if a human is looking at the tab and offers to point, **`pick_element`** lets them click the element directly. On WordPress or an unfamiliar stack, run **`page_origins`** once so you know what you will be attributing against (and whether an optimizer bundle needs bypassing).
3. **What: `inspect_element`** — confirm the rendered reality: visibility verdict, real box, computed → used pairs. If the element is constrained/clipped/stacked by something above it, **`inspect_ancestors`** with the matching concern names the binding ancestor.
4. **Why: `explain_styles`** — usually with `property:` once you know what is wrong (`{ uid: "e5", property: "margin-bottom" }`). The WINNER's `→ file:line [granularity | origin — edit hint]` is the edit target; check the notes for INACTIVE declarations and `@media`/`@layer` context before editing.
5. **Verify: `style_diff`** — `{ uid: "e5", mode: "record" }`, apply the fix, `navigate` to reload (uids go stale, but the slot re-resolves by selector), then `{ mode: "compare" }`. The diff should contain exactly the properties you meant to change — nothing missing, nothing extra.

Related reading: [architecture.md](architecture.md) (how the deterministic pipeline works), [wordpress.md](wordpress.md) (origin resolution details), [../SPEC.md](../SPEC.md) (the authoritative spec).
