# Tool reference

Visionaire Engine exposes 28 MCP tools: three session tools (`connect`, `navigate`, `set_viewport`), sixteen inspection tools — ten for the frozen moment (what the page looks like and why), three for the time dimension (`get_listeners`, `explain_animations`, `record_interaction` — what happens and why), plus three added in v0.4: `interact` (drive the UI into a state and leave it there), `measure_element` (sub-pixel glyph/text-ink centering), and `evaluate` (the escape hatch for genuinely bespoke reads) — three fix-loop/pixel tools from v0.5–v0.6 (`inject_css`, `check_alignment`, `pick_color`), and six **verification tools new in v0.7**: `assert_visual`, `visual_diff`, `impact_preview`, `diagnose`, `responsive_sweep`, `capture_proof` (documented in [Verification & proof](#verification--proof-v07) below). The older tools emit plain text (plus one PNG for `annotated_screenshot`); the six v0.7 tools return a **compact JSON envelope** instead — `{verdict?, summary, …, truncated, next_offset?, artifacts?}` — and return images only as **file paths** on disk, never inline. `check_alignment` is deprecated in favor of `assert_visual` (which adds PASS/FAIL verdicts and re-runnable suites) and will be removed in a future release. All output is deterministic and token-budgeted. Concepts and vocabulary come from [architecture.md](architecture.md); this page documents the tools as implemented.

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

**`[granularity | label — edit hint]`** — the honesty-ladder bracket after the location. Granularity is one of `line` > `file` > `db-entity` > `component` > `generated` > `unknown`. The label names the origin (`theme: astra`, `plugin: myplugin`, `Elementor (post 88)`, `Customizer > Additional CSS`); the part after `—` is the actionable edit surface (`edit this file`, `Elementor editor for post 88 > widget 4f2a1c`, `generated bundle — re-inspect with bypass query param ?nowprocket`). Label and hint are omitted when they add nothing; a sheet-backed rule that could not be classified still gets a bare `[unknown]` plus its selector and declaration text — never silence.

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

**`INACTIVE` notes** — winning declarations that have no effect ("you set it, but…"), from a closed ruleset (width/height on inline elements, flex-item props without a flex parent, `z-index` on `position: static`, `top/left` on static, `text-overflow` without `overflow:hidden` + `nowrap`, and more). Each note gives the declaration, its short location, the reason, and a fix hint:

```
- 'z-index: 9999' at theme.css:18 is INACTIVE — 'z-index' has no effect on a position:static element that is not a flex or grid item; add position:relative (or absolute/fixed/sticky)
```

**Other notes** — `winner for X sits inside @media (min-width: 768px)` / `… inside @layer fixture` (the winning rule's conditional context); `verdict-uncertain (computed disagrees) for X: predicted '…', computed '…'` (the engine never silently guesses); `@keyframes present (name) — animated values are not modeled in v0.1; verdicts reflect the static cascade`.

**`[N more properties — ask with property:]`** — the dossier hit its ~800-token budget; the remaining, less-contended properties were dropped. Re-ask with `property:` for any of them (property-filtered calls are never truncated).

## inspect_ancestors

Walk the ancestor chain (self → root) for one concern, printing one compact line per ancestor with only the concern-relevant computed properties and flagging the **binding constraint** — the nearest ancestor that actually limits the element. Use it when an element is sized, clipped, positioned, or stacked by something above it and you need to know *which* ancestor. Every line carries a uid, so you can drill into any hop with `explain_styles`.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `uid` / `selector` / `x`+`y` | TargetSpec | required (one) | Which element |
| `concern` | `'width' \| 'height' \| 'position' \| 'overflow' \| 'stacking'` | `'width'` | Which constraint chain to report |

Per concern the summary shows: **width/height** — `width`/`max-width`/`min-width`, `box-sizing`, paddings, non-block display, `flex-basis` for flex items, explicit inline `style="width: …"`, and the flex min-size trap: a row flex item whose implicit `min-width: auto` is what makes its row overflow renders `min-width:auto (flex item) — prevents shrinking below content` (column direction gets the `min-height` analog); **position** — `position`, non-auto insets, `z-index`, and `transform:set (containing block)` (a transformed ancestor is the containing block even for `position:fixed`); **overflow** — `overflow`, `clip-path`, `contain`, `content-visibility`; **stacking** — `z-index`, `position`, and the stacking-context creator reason.

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

And the flex min-size trap (a nowrap SKU string keeps the first cell of a 480px flex row from shrinking):

```
ancestors of e1 <div.cell> — concern: width (self → root)
e1 <div.cell> width:567.406px min-width:auto (flex item) — prevents shrinking below content padding-x:8px flex-basis:0% [BINDING]
e2 <div.row> width:480px display:flex
e3 <body> width:1232px padding-x:24px
e4 <html> width:1280px
```

The trap fires only when all of it is true: the parent is a row-direction flex container, the item's computed `min-width` is `auto` with `overflow: visible` (any other overflow value drops the automatic minimum to zero) and `flex-shrink > 0`, **and** the parent's content actually overflows its box — a healthy flex row never triggers it.

Identity lines follow the same `<tag#id.classes>` format as the other tools: the `#id` when the element has one, then up to 3 classes. `[BINDING]` marks the nearest qualifying *ancestor* — the element itself can take it only for the flex min-size trap, where the shrink blocker genuinely lives on the element's own implicit minimum. For `concern: 'stacking'`, when the element has a numeric z-index and its nearest stacking context is not the root, a closing note explains the trap: `note: z-index:9999 is scoped inside context created by e12 (transform) — it cannot escape that context`. Very deep chains are pruned to ~800 tokens, keeping self, the nearest ancestors, and always the root line, with `[N more ancestors pruned]`.

## find_elements

Deterministic page search — the grounding tool for "the button under the hero". Criteria are AND-combined by default; pass `match: "any"` for a union (OR) when over-specifying returns nothing. Matching is exact and rule-based (no fuzzy matching — that stays with the calling LLM, which can search several times cheaply). Text matching is a case-insensitive substring test on normalized `innerText`, preferring elements whose *own* text nodes contain the needle and otherwise keeping only the deepest matches so wrappers do not shadow the real hit.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `text` | string | — | Case-insensitive substring of the element's own text |
| `selector` | string | — | CSS selector, matched via `querySelectorAll` |
| `role` | string | — | ARIA role: explicit `[role]` attribute or tag-implied (`link`, `button`, `heading`, `navigation`, `textbox`, `list`, …) |
| `region` | `{x, y, width, height}` | — | Viewport rectangle (CSS px) the element must intersect |
| `match` | `"all"` \| `"any"` | `"all"` | How the criteria combine: `all` = AND (intersection), `any` = OR (union). Use `any` when a precise combination of criteria returns nothing |
| `visibleOnly` | boolean | `true` | Drop elements hidden by display/visibility/opacity. Set `false` to include `display:none`/hidden elements — honored in both `all` and `any` modes |
| `limit` | integer 1–100 | `10` | Maximum matches returned |

At least one of `text` / `selector` / `role` / `region` is required. `match` and `visibleOnly` alone are not criteria.

**Output** — a count header plus one compact line per match, in viewport coordinates:

```
1 element found:
e5 <a.btn> "Get started" 146x42 @(40,142)
```

When more matched than were shown: `27 elements found — showing first 10 (raise limit or narrow criteria):`. When nothing matched, the message names the recovery levers that actually apply — e.g. `match:"any"` when you are AND-combining more than one criterion, and `visibleOnly:false` when hidden elements might be excluded — and routes you to `page_snapshot`.

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
| `clipTo` | `{uid \| selector \| x,y}` | — | **Element-scoped crop**: clip the shot to one element's border box. Target by uid, selector, or a viewport point |
| `padding` | number | `0` | `clipTo` only: extra pixels of margin around the cropped element on every side |
| `scale` | number 0.5–4 | `1` | `clipTo` only: zoom factor for the crop (2 = double size) — enlarge a tiny element like an `×` so you can actually see it |
| `annotate` | boolean | `true` | Set `false` for a clean, unlabelled crop so marks never cover the target |

Two modes: the default **overview** marks interactive/landmark elements (or the `uids` you pass); **element-scoped** (`clipTo`) crops to one element's border box, optionally padded, zoomed via `scale`, and with `annotate:false` for a bare crop. `clipTo` is the right tool when you want to *see* one small element up close rather than orient over the whole page.

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
| `capture_pixels` | boolean | `false` | `record` only (v0.7): also save a clean viewport screenshot as a **pixel baseline** under this slot, for a later `visual_diff { reference: { baseline_slot: slot } }` comparison |

Slots survive navigation: alongside the uid, `record` stores a selector (the one you targeted with, or `#id` if the element has an id) and `compare` re-resolves through it when the uid has gone stale. The baseline is *not* re-recorded on compare — repeated compares keep diffing against the original recording until you `record` again.

**Output** — real record/compare pair (baseline taken, then the fixture button given `display: inline-block; margin-bottom: 8px`):

```
recorded 55 computed properties + box model for e5 under slot 'default'. Make your change, then call style_diff { mode: 'compare', slot: 'default' }.
```

With `capture_pixels: true` the record confirmation adds the pixel-baseline pointer (real output):

```
recorded 55 computed properties + box model for e1 under slot 'box'. Make your change, then call style_diff { mode: 'compare', slot: 'box' }. pixel baseline saved — compare with visual_diff { reference: { baseline_slot: 'box' } }.
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

## get_listeners

The bridge from "this button" to "this JS file": every event listener on an element — and, by default, on its ancestor chain up through `document` and `window`, because delegated handlers live up the tree — with the handler's file:line (source-mapped when possible, WordPress-labeled like CSS attributions) and the flags that cause real bugs: `capture`, `passive` (`preventDefault` silently ignored!), `once`. Use it when a click/hover/input "does nothing", when you need to know which script owns a behavior before editing, or before `record_interaction` to know what a click will run. An **empty answer is an answer**: no click listener on the element or anywhere above it means nothing on the page reacts to that click — the handler is missing or attached to the wrong element.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `uid` / `selector` / `x`+`y` | TargetSpec | required (one) | Which element |
| `eventType` | string | all types | Filter to one event type, e.g. `"click"` |
| `includeAncestors` | boolean | `true` | Also report listeners up the ancestor chain, `document`, and `window` |

**Output** — real examples (bench cases 21/22 fixtures). A button with a direct handler:

```
listeners on e1 <button.toggle> "Hide sidebar"
  click → hideSidebar @ …/js/case21-sidebar.js:10  [line]
ancestors:
  (none up the chain — document and window included)
```

And the honest absence — the close handler was attached to a hidden sibling, so the visible button has nothing:

```
listeners on e1 <button.close-btn> "×" — click only
  (none for click on the element itself — delegated handlers may live on the ancestors below)
ancestors (click):
  (none up the chain — document and window included)
```

Listener lines read `type → handlerName @ file:line  [granularity | origin]  (flags)`. Handler names are recovered from script source (anonymous/arrow handlers render as plain `handler`; inline `onclick="…"` attributes render as `inline onclick attribute`). Flags appear only when non-default — except `passive`, which is always spelled out for scroll-blocking events (`wheel`, `touchstart`, `touchmove`). **Delegation honesty rule**: a handler whose script is a known delegation framework is labeled `delegated (react-dom)` / `(jquery)` / `(vue)` with a closing note that the component-level handler is not resolvable at the DOM level — read the component source; the tool never pretends to find the JSX handler.

## explain_animations

Animations and transitions touching one element, both halves deterministic: what is animating **now** (an in-page `getAnimations()` census — type, play state, timing, animated properties) and what is **declared** even when idle (the winning `transition`/`animation` declarations and `@keyframes`, attributed to file:line through the same cascade + origin machinery as `explain_styles`). On top of both sits a closed "not smooth" ruleset: non-animatable properties in `transition-property` (R1), the `width`/`height: auto` interpolation trap (R2), main-thread (layout/paint) jank risk for properties outside transform/opacity/filter (R3), missing or zero-duration transitions — "changes are instant by design" (R4), active `prefers-reduced-motion` (R5), and the rAF-blindness honesty note when the census is empty (R6). Use it when something "pops instead of fading", stutters, or never animates at all.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `uid` / `selector` / `x`+`y` | TargetSpec | required (one) | Which element |
| `property` | string | — | CSS property you *expected* to animate — arms the R4 "changes are instant" check for it |

**Output** — real example (bench case 23: `transition: opacity` with the duration forgotten, `property: "opacity"`):

```
animations on e1 <div.card.visible>
active now: none
declared:
  transition: opacity — 0s ease  → cases/css/case23.css:6  [line | 127.0.0.1:49836 — edit this file]
findings:
  ⚠ transition-property covers 'opacity' but its transition-duration is 0s — changes are instant by design — fix: set a non-zero transition-duration for it
notes:
  - no active animations in the getAnimations() census — JS requestAnimationFrame animations are invisible to this census — use record_interaction to observe the change happening
```

`active now:` lists running animations with play state and timing; `declared:` carries the file:line + honesty-ladder bracket per declaration; each `findings:` line is one rule hit with a fix hint. Compositor status is the static R3 classification — authoritative trace-based failure reasons remain future work. Animations created purely from JS (`requestAnimationFrame` loops) are invisible to the census by nature; the R6 note says so explicitly and points at `record_interaction`.

## record_interaction

One interaction, one source-attributed causal timeline. The tool performs (or watches) a single interaction and records what happened — handler dispatch, DOM mutations, transitions starting/being cancelled, layout shifts, console errors — each line time-stamped, uid-keyed, and attributed to file:line where the platform provides attribution. It is built on Chrome's own passively-computed signals (Long Animation Frames script attribution, `layout-shift` sources, creation stack traces for inserted nodes) merged with the CDP Animation and DOM event streams — **not** a bespoke mutation tracer, and never a debugger pause (pausing mid-interaction would cancel the very animations under investigation). Use it for "the animation isn't smooth", "clicking does something weird", or any bug you can only see *while it happens*.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `uid` / `selector` / `x`+`y` | TargetSpec | required for `click`/`hover` | What to interact with |
| `action` | `'click' \| 'hover' \| 'manual'` | `'click'` | `manual` waits `waitMs` while a human performs the interaction in the headed tab (pairs with `pick_element`) |
| `waitMs` | number | `1500` (clamped 200–10000) | How long to keep recording after the action |
| `maxEvents` | number | `40` | Hard cap on timeline lines; similar sibling mutations are coalesced first |

**Output** — real example (the flagship bench case 21: a hide-sidebar handler starts a width transition, then a premature cleanup timeout sets `display:none` mid-flight):

```
interaction: click on e1 <button.toggle> "Hide sidebar"  (recorded 1500ms, 10 events)
t=0     click → handler hideSidebar @ js/case21-sidebar.js:10
t=95ms  layout shift 0.02 — main.content moved 114px left
t=95ms  e2 <aside.sidebar> class +collapsed  (mutation attribution unavailable; likely by js/case21-sidebar.js:10 (hideSidebar) — only script running in that frame)
t=95ms  transition started on e2: width 300ms ease
t=98ms  layout shift 0.00 — main.content moved 16px left
t=107ms layout shift 0.00 — main.content moved 17px left
t=115ms layout shift 0.00 — main.content moved 14px left
t=116ms e2 <aside.sidebar.collapsed> inline style changed → "display: none;"  (mutation attribution unavailable; likely by js/case21-sidebar.js:10 (hideSidebar) — only script running in that frame)
t=122ms layout shift 0.03 — main.content moved 119px left
t=123ms ✗ transition CANCELLED on e2 (width) — a style/display change removed it mid-flight. That is the jump.
```

Honesty notes are part of the format: CDP DOM events carry no timestamps, so `t=` offsets are best-effort and arrival order is authoritative; creation stacks cover node *insertions* only, so attribute/class mutations are labeled `(mutation attribution unavailable …)` — softened to "likely `script:line`" when exactly one script ran in that frame; LoAF script attribution names the entry-point function of same-origin scripts, not the whole call chain. Everything the recording window enables (mutation events, creation stacks, the Animation domain, the in-page `PerformanceObserver` buffer) is torn down when the tool returns, success or error.

## interact

Drive the UI into a state and **leave it there**. `interact` performs exactly one action at the target — click, hover, or focus — and does *not* record, tear anything down, or revert: a popup opened here stays open, so you can then `page_snapshot` / `inspect_element` / `annotated_screenshot` / `explain_styles` the resulting state. It reports the target's post-action visibility and content box so you learn immediately whether the action opened what you expected.

This is the sibling of `record_interaction`: `record_interaction` opens the Animation/Debugger/mutation channels, captures a causal *timeline*, and tears every channel back down (often returning the page to its pre-interaction state); `interact` does the minimum and leaves you *in* the new state. Reach for `interact` to get somewhere ("open the menu, then tell me why it overflows"); reach for `record_interaction` to explain the transition itself.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `uid` / `selector` / `x`+`y` | TargetSpec | required | What to act on |
| `action` | `'click' \| 'hover' \| 'focus'` | `'click'` | `hover` moves the mouse over the target; `focus` focuses it (falls back to in-page `el.focus()`) |
| `settleMs` | number | `250` (clamped 0–5000) | How long to wait for the UI to react before reporting the target's new state |

**Output** — a one-line verdict plus a re-snapshot nudge:

```
clicked e5 <button#trigger> — after 250ms: it is now visible 364x264 @(458,268).
The page is now left in this new state. uids may have changed and new elements may have appeared — take a fresh page_snapshot to inspect the new state, then inspect_element / annotated_screenshot it.
```

The reported box is the **content box** (matching `inspect_element` / `measure_element`). After the settle wait, `interact` re-resolves the same target (a fresh `backendNodeId` if the DOM swapped the node) and reports its post-action state, falling back to the original node if the target vanished (e.g. a close button that removes itself). If the target has no clickable geometry (`display:none`, zero-size, detached), it errors and tells you to make it visible first.

## measure_element

Deterministic rendered-pixel geometry, for the questions the box model can't answer. `measure_element` reports an element's **content box** (WxH @x,y) and the true **text-ink bounding box** of its text — canvas `measureText` glyph extents (the painted ink, not the advance box), anchored to the text's painted position via a DOM Range — then a sub-pixel **centering verdict**: how far the ink center sits from the content-box center on each axis, with a padding/line-height fix hint. This answers "is this glyph *actually* centered?" without a hand-rolled CDP+canvas harness. Optionally pass a reference element to also get the center delta between the two elements.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `uid` / `selector` / `x`+`y` | TargetSpec | required | What to measure |
| `referenceUid` | string | — | Optional reference element (by uid) to measure alignment against — reports the content-box-center delta |
| `referenceSelector` | string | — | Optional reference element (by selector) to measure alignment against |

**Output** — box, ink, and centering (the "close button × looks off-center" case):

```
element e2 <button.close> "×"
content box: 30x30 @(1181,25)
text ink: 6.8x6.8  font 16px "Arial"  text "×"
centering (text ink vs content box):
  horizontal: -8.3px (ink left of center)
  vertical:   +0.3px (ink below center)
  ink center 8.3px left of box center → shift content right 8.3px (e.g. adjust padding-right)
```

Because the content box already excludes padding and border, symmetric-looking box models can still hide a real *visual* offset — an off-center glyph shows up here as a non-zero ink delta even when `inspect_element` reports a perfectly square box. `explain_styles` tells you which rule set the value; `measure_element` tells you whether the painted glyph lands where you want. Deltas round to 0.1px; a value under 0.5px reads as centered. When the element has no text, the ink section reads `(no text to measure)` and only the content box and any reference delta are reported.

## evaluate

The explicit **escape hatch**. `evaluate` runs agent-authored JavaScript in the top-level frame and returns the JSON result — for the genuinely bespoke case that no purpose-built tool covers: a custom measurement, forcing a UI state (dispatch an event, toggle a class), or reading framework/component state. Prefer `explain_styles` / `measure_element` / `inspect_element` / `interact` where they apply; reach for `evaluate` only when none of them fits.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `expression` | string | required | JS evaluated in the page — an expression, a bare object literal (`{ w: innerWidth }`), or an IIFE for multi-step logic |
| `awaitPromise` | boolean | `true` | If the expression yields a Promise, await it and return the resolved value |
| `timeoutMs` | number | `5000` (clamped 100–30000) | Max run time before aborting |

**Output** — the value as JSON:

```
{"w":1280,"h":800}
```

The JS is **trusted** — you wrote it — so unlike page-derived text elsewhere in the engine, the result is returned verbatim, *not* run through the page-text sanitizer (you asked for this data deliberately). It is size-capped (~6000 chars) and truncated with a note if larger. A bare `{ … }` object literal is auto-wrapped in parens so it evaluates to the object rather than a statement block. Values that don't JSON round-trip (a DOM node, `Map`, `Date`, `RegExp`, function, …) are described as `[non-serializable …]` rather than collapsed to `{}`; a runtime throw comes back as `evaluate error: <first line>`, and a timeout or a self-referential graph like `window` returns an actionable message telling you to project a smaller value.

---

## Verification & proof (v0.7)

The six tools below close the verify loop: state a claim about the rendered page and get a measured verdict instead of trusting a source diff. Unlike the plain-text dossier tools above, they all return a **compact JSON envelope** — `{verdict?, summary, …, truncated, next_offset?, artifacts?}` — kept under a ~15 KB byte budget (override with the `VISIONAIRE_MAX_RESPONSE_KB` env var; when a response would exceed it, the page/list is halved until it fits and `truncated: true` + `next_offset` mark what was dropped). Images are returned only as **file paths** into the artifacts directory (`$VISIONAIRE_ARTIFACTS_DIR`, default `<tmpdir>/visionaire-artifacts`), never inline. Successful `assert_visual` / `visual_diff` / `responsive_sweep` calls also write the `.claude/.visionaire_verified` marker consumed by the [verify-after-edit harness](harness.md).

## assert_visual

The verification gate. State verifiable rendered-geometry claims — "these cards are equal height", "the nav gaps are 16px", "nothing clips this banner" — and get a deterministic per-assertion `PASS`/`FAIL`/`ERROR` verdict with the measured pixel actuals and the offending element uids. Call it after every visual edit instead of claiming success from reading source. Pass `suite_id` alongside `assertions` to register the set as a named, re-runnable suite (persisted as JSON under `<cwd>/.visionaire/suites`, or `$VISIONAIRE_SUITE_DIR`); later call with **only** `{suite_id}` to re-run the stored suite against the current render, or hand the id to `responsive_sweep` / `capture_proof`.

All measurements are in **document CSS px** (viewport rect + scroll offset), so verdicts are stable across scroll positions. Before comparing, values are snapped to the device-pixel grid (rounded at `devicePixelRatio`), then the tolerance applies — `tolerance_px` defaults to **1**, settable globally or per assertion. The overall `verdict` is `FAIL` if **any** assertion is `FAIL` or `ERROR`.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `assertions` | array (1–100) | — | Assertions to evaluate (see the grammar below); omit to re-run a stored `suite_id` |
| `suite_id` | string | — | With `assertions`: register them as a named suite. Alone: re-run the stored suite |
| `tolerance_px` | number 0–100 | `1` | Global edge/size tolerance in CSS px |
| `detail` | `'summary' \| 'full'` | `'summary'` | `full` adds per-assertion prose explanations; `summary` drops them (the measured numbers stay — they ARE the verdict). ERROR results keep their explanation either way |
| `stop_on_first_fail` | boolean | `false` | Stop evaluating after the first FAIL/ERROR (skipped assertions force overall FAIL) |
| `page` | `{offset, limit ≤ 200}` | `{0, 50}` | Paginate the results array of a large suite |

Each assertion is `{ id?, type, targets, params?, tolerance_px? }`. **Targets** are an array of: a uid string (`"e8"`), `{ selector }` — which expands to **all** matches — or `{ role, name? }` (ARIA role + exact accessible name). The full grammar (17 types):

| Type | Targets | Params | PASS when |
|---|---|---|---|
| `equal_height` | 2+ | — | content-box heights spread ≤ tolerance |
| `equal_width` | 2+ | — | content-box widths spread ≤ tolerance |
| `aligned_edges` | 2+ | `edge: 'left'\|'right'\|'top'\|'bottom'` (required) | that border-box edge coordinate's spread ≤ tolerance |
| `centered` | 1 | `in: 'parent'\|'viewport'` (default `parent`), `axis: 'x'\|'y'\|'both'` (default `both`) | opposing gaps to the container differ ≤ tolerance on each checked axis |
| `gap_equals` | 2+ | `axis: 'x'\|'y'` (required), `value` px (required) | every adjacent gap along the axis is within tolerance of `value` |
| `spacing_equals` | 3+ | `axis: 'x'\|'y'` (required) | adjacent gaps are mutually equal (spread ≤ tolerance) |
| `visible` | 1 | — | not `display:none` / `visibility:hidden` / `opacity:0`, has a non-zero-area box intersecting the viewport |
| `not_clipped` | 1 | — | content box does not exceed any clipping ancestor (`overflow` ≠ visible) by > tolerance on any side |
| `not_overlapped` | 1 | — | no non-ancestor/descendant element painted **above** it overlaps by > tolerance on both axes |
| `within_viewport` | 1 | `fully` (default `true`) | fully: no side extends past the viewport by > tolerance; `fully:false`: any intersection at all |
| `color_equals` | 1 | `property: 'text'\|'background'\|'border'` (default `text`), `value` CSS color (required), `deltaE` (default 2) | measured color within ΔE(OKLab×100) of expected. `background` uses the painted composited pixel sample when available |
| `color_near` | 1 | same as `color_equals` | same, with a looser default `deltaE` of 5 |
| `z_above` | exactly 2 `[A, B]` | — | A's paint order is above B's |
| `text_not_truncated` | 1 | — | `scrollWidth − clientWidth` ≤ tolerance (notes `text-overflow: ellipsis` when set) |
| `text_not_overflowing` | 1 | — | the union of the element's text-glyph rects stays inside its content box (± tolerance) |
| `size_equals` | 1 | `width_px` and/or `height_px` (at least one required) | content-box size within tolerance of the expected dimensions |
| `positioned` | exactly 2 `[A, B]` | `relation: 'left_of'\|'right_of'\|'above'\|'below'\|'inside'\|'contains'` (required) | the spatial relation holds between the two border boxes (± tolerance) |

Target problems are reported as **per-assertion `ERROR` verdicts, not tool errors** — the rest of the battery still runs. Error codes: `TARGET_NOT_FOUND` (a target resolved no element, or fewer than the type's minimum), `TARGET_AMBIGUOUS` (a single-target type resolved more than its maximum, or a selector/role expanded past the 40-element cap — a truncated element set could flip a verdict, so the tool refuses instead of silently measuring a subset), `UNKNOWN_ASSERTION_TYPE`, `INVALID_PARAMS`, `MEASUREMENT_FAILED`. A dead browser session is a tool error (re-`connect`), never a per-assertion code.

**Output** — the JSON envelope. Real captured battery (assert fixture, `detail: 'full'`, trimmed to three of four results):

```json
{
 "verdict": "FAIL",
 "summary": "4 assertions: 2 PASS, 2 FAIL",
 "results": [
  {
   "type": "equal_height",
   "verdict": "FAIL",
   "id": "eq-h",
   "measured": { "values": [412, 388], "unit": "px", "delta": 24, "tolerance_px": 1 },
   "offending_uids": ["e1", "e2"],
   "explanation": "e1 content-box height 412px vs e2 388px; delta 24px exceeds 1px tolerance"
  },
  {
   "type": "gap_equals",
   "verdict": "PASS",
   "id": "gap",
   "measured": { "axis": "x", "gaps": [16, 16, 16], "expected": 16, "tolerance_px": 1 }
  },
  {
   "type": "not_clipped",
   "verdict": "FAIL",
   "id": "clip",
   "measured": { "ancestor_uid": "e8", "ancestor_overflow": "hidden", "exceed": { "left": 0, "right": 34, "top": 0, "bottom": 0 }, "tolerance_px": 1 },
   "offending_uids": ["e7", "e8"],
   "explanation": "e7 is clipped by ancestor e8 <div#clip-wrap> (overflow:hidden) — content exceeds it by 34px on the right"
  }
  […1 more result elided]
 ],
 "truncated": false
}
```

Registering a suite appends to the summary: `— registered as suite 'cards' (re-run with just {"suite_id":"cards"})`. Re-running the stored suite after the fix (real output):

```json
{
 "verdict": "PASS",
 "summary": "1 assertion: 1 PASS, 0 FAIL",
 "results": [
  {
   "type": "equal_height",
   "verdict": "PASS",
   "id": "cards-equal",
   "measured": { "values": [412, 412], "unit": "px", "delta": 0, "tolerance_px": 1 }
  }
 ],
 "truncated": false,
 "suite_id": "cards"
}
```

Real ERROR verdicts (bad targets and a typo'd type in one battery):

```json
{
 "verdict": "FAIL",
 "summary": "3 assertions: 0 PASS, 0 FAIL, 3 ERROR",
 "results": [
  { "type": "visible", "verdict": "ERROR", "error": "TARGET_NOT_FOUND",
    "explanation": "selector \".does-not-exist\" matches 0 elements (resolved_count: 0)", "id": "ghost" },
  { "type": "size_equals", "verdict": "ERROR", "error": "TARGET_AMBIGUOUS",
    "explanation": "size_equals takes exactly 1 element(s); targets resolved to 2 — narrow the selector", "id": "many" },
  { "type": "equal_heigth", "verdict": "ERROR", "error": "UNKNOWN_ASSERTION_TYPE",
    "explanation": "unknown assertion type \"equal_heigth\" — known: equal_height, equal_width, aligned_edges, centered, gap_equals, spacing_equals, visible, not_clipped, not_overlapped, within_viewport, color_equals, color_near, z_above, text_not_truncated, text_not_overflowing, size_equals, positioned", "id": "typo" }
 ],
 "truncated": false
}
```

Re-running an unregistered suite is a tool error, quoted verbatim: `SUITE_NOT_FOUND: no suite named "no-such-suite". Known suites: cards. Register one by calling assert_visual with both assertions and suite_id.` Budget: `offending_uids` are capped at 20 per assertion (`offending_uids_truncated: true` marks the cut); results paginate via `page` and the whole envelope shrinks its page until it fits the ~15 KB backstop, signalled by `truncated: true` + `next_offset`.

## visual_diff

Pixel-level "does it still look right?": captures the current viewport (or one element as a clean border-box crop) and diffs it against a reference PNG — a mockup file (`reference.image_path`) or a pixel baseline recorded earlier with `style_diff { mode: 'record', capture_pixels: true }` (`reference.baseline_slot`). The diff is a pure pixelmatch-style engine (YIQ perceptual distance, anti-aliasing dismissal); divergent grid regions are mapped back to **likely element uids** via the DOMSnapshot paint index, so you learn *which element* changed, not just that pixels did. For geometry claims (heights, alignment, spacing) prefer `assert_visual` — it is OS-stable integer math, while pixel diffing is inherently environment-sensitive (fonts, GPU rasterization).

The diff runs in image (device) pixels; region bboxes come back in **document CSS px**, ready for `inspect_element`. `ignore_regions` are CSS px relative to the captured area's top-left. A capture and reference of different dimensions is a `layout-diff`: verdict `DIVERGENT` at 100% with a summary telling you to re-record at the current size.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `target` | `'page'` \| `{uid \| selector}` | `'page'` | What to capture: the viewport, or one element's clean border-box crop |
| `reference` | `{image_path}` \| `{baseline_slot}` | required (exactly one) | The PNG to compare against |
| `threshold` | number 0–1 | `0.1` | Per-pixel YIQ color-distance threshold (pixelmatch semantics; smaller = stricter) |
| `accept_pct` | number 0–100 | `0.1` | Verdict line: `MATCH` when `divergence_pct` ≤ this |
| `ignore_antialiasing` | boolean | `true` | Dismiss pixels that look like font/edge anti-aliasing |
| `ignore_regions` | `{x,y,width,height}[]` | `[]` | Rectangles to exclude, CSS px relative to the captured area |
| `mask_dynamic` | (uid \| `{selector}`)[] | `[]` | Elements whose current border boxes are excluded — timestamps, ads, carousels |
| `emit_heatmap` | boolean | `false` | Write a diff heatmap PNG (dimmed capture, differing pixels in red) and return its path in `artifacts` |
| `region_grid` | integer 1–16 | `8` | Report divergence per NxN grid over the capture |

**Output** — the JSON envelope: verdict, divergence stats, and up to 20 grid regions above a 0.5% noise floor, each with ≤ 3 likely uids. Real captured DIVERGENT run (the fixture box recolored after recording a baseline, trimmed to two of four regions):

```json
{
 "verdict": "DIVERGENT",
 "summary": "DIVERGENT — divergence 1.0547% (10800 of 1024000 compared px, accept_pct 0.1) for viewport vs baseline 'box'; 4 region(s) above the 0.5% noise floor; worst r1c0 @ 26.25%",
 "reason": "pixel-diff",
 "divergence_pct": 1.0547,
 "diff_pixels": 10800,
 "total_pixels": 1024000,
 "accept_pct": 0.1,
 "regions": [
  { "grid": "r1c0", "bbox": { "x": 100, "y": 100, "width": 60, "height": 70 },
    "divergence_pct": 26.25, "likely_uids": ["e1"] },
  { "grid": "r1c1", "bbox": { "x": 160, "y": 100, "width": 60, "height": 70 },
    "divergence_pct": 26.25, "likely_uids": ["e1"] }
  […2 more regions elided]
 ],
 "truncated": false,
 "artifacts": [
  { "kind": "diff-heatmap", "path": "/var/folders/…/visionaire-docs-1GhGPl/artifacts/diff_0001.png" }
 ]
}
```

A clean comparison reads `"verdict": "MATCH", "summary": "MATCH — divergence 0% (0 of 1024000 compared px, accept_pct 0.1) for viewport vs baseline 'box'"` with `"regions": []`. Errors, quoted verbatim: an empty slot throws `BASELINE_SLOT_EMPTY: no pixel baseline recorded under slot 'nothing' — record one with style_diff { mode: 'record', capture_pixels: true, slot: 'nothing' } before comparing`; a missing file throws `REFERENCE_NOT_FOUND: no readable file at "…" — check the path, or record a baseline with style_diff { mode: 'record', capture_pixels: true } and compare via reference.baseline_slot`; captures beyond 32 M pixels throw `CAPTURE_TOO_LARGE` with a `set_viewport` hint. Budget: the regions list is halved until the envelope fits ~15 KB (`truncated: true` marks dropped regions).

## impact_preview

Blast-radius report to run **before** editing a shared CSS selector. Answers two questions deterministically: who else matches this selector on the current page (true match count, uids, identities, grouped by visual role / screen region / tag), and — with `proposed_change` — what would *actually* change if the declarations landed, via a sandboxed dry-run: a temporary `<style data-visionaire-impact>` is injected, computed values are diffed before/after a forced recompute, and the style is always removed. Elements protected by more specific or `!important` rules land in `unaffected_count`. Scope honesty is part of the output: everything is the current page at the current viewport — other routes/viewports/states are invisible to a live-page tool.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `selector` | string | required | The shared selector you are about to edit — all current matches are counted and grouped |
| `group_by` | `'visual_role' \| 'region' \| 'tag'` | `'visual_role'` | `visual_role` = tag + up-to-2 classes + screen region + ARIA role; `region` = top/middle/bottom of the document; `tag` = element tag name |
| `proposed_change` | `{declarations: {prop: value}}` | — | Dry-run these declarations (max 20) against the live render |
| `detail` | `'summary' \| 'full'` | `'summary'` | `full` additionally saves an annotated screenshot of the first matches to the artifacts dir |
| `page` | `{offset, limit ≤ 100}` | `{0, 20}` | Paginates `dry_run.changed` when a dry-run ran, otherwise the groups list |

**Output** — the JSON envelope. Real captured dry-run (`.nav-item` shared by 23 elements across a header, sidebar, and footer; groups trimmed to one of three):

```json
{
 "summary": "'.nav-item' matches 23 elements across 3 visual roles, 3 screen regions. impact is computed for the currently open page at the current viewport only — other routes/viewports/states are not visible here (use responsive_sweep for other viewports)",
 "match_count": 23,
 "groups": [
  {
   "key": "a.nav-item@bottom[role=link]",
   "count": 9,
   "uids": ["e15", "e16", "e17", "e18", "e19", "e20", "e21", "e22", "e23"],
   "region": "bottom",
   "sample_identity": "<a.nav-item>"
  }
  […2 more groups elided]
 ],
 "truncated": true,
 "dry_run": {
  "would_change_count": 22,
  "unaffected_count": 1,
  "changed": [
   { "uid": "e1", "prop": "padding", "before": "8px", "after": "20px" },
   { "uid": "e2", "prop": "padding", "before": "8px", "after": "20px" }
   […4 more rows elided]
  ],
  "method": "sandboxed inject_css + recompute"
 },
 "next_offset": 6
}
```

The one unaffected element here has `padding: 4px !important` — the dry-run proves the proposed rule cannot beat it. A declaration that changes nothing gets a verbatim note: `DRY_RUN_UNSUPPORTED_DECLARATION: 'prop: value' changed the computed value of 0 matched elements — a more specific or !important rule may beat the injected rule, a media query may gate it, or every element already computes to that value`. A selector matching nothing returns `match_count: 0` with a spelling/navigation hint instead of an error. Budget: per-element facts and the dry-run cover the first 40 matches (`match_count` stays exact, with a note when capped); ≤ 20 changed rows per page, ≤ 50 uids per group (`uids_truncated: true` marks squeezed groups); the page is halved, then per-group uid lists squeezed, until the envelope fits ~15 KB.

## diagnose

One-shot "why does this element look broken": runs a deterministic symptom battery against one element and returns **ranked culprits** with measured pixel evidence — no AI, every culprit is a measured fact. The tool to call when `assert_visual` returns FAIL and you need the cause, or when the user says "it looks broken" without saying why. Fix the named culprit, then re-run `assert_visual`.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `uid` / `selector` / `x`+`y` | TargetSpec | required (one) | Which element |
| `symptom` | see taxonomy below | `'auto'` | What looks broken; `auto` runs the ordered battery |
| `expected` | `{width_px?, height_px?, centered_in?}` | — | What the element SHOULD look like — required for `wrong_size` |
| `max_culprits` | integer 1–10 | `5` | Cap on ranked culprits returned |

The symptom taxonomy (all coordinates document CSS px):

| Symptom | What it checks | Culprit `cause` emitted |
|---|---|---|
| `invisible` | the visibility decision tree (display, visibility, opacity, zero-size, off-viewport, clipped, occluded) | `invisible_<status>` |
| `clipped` | each clipping ancestor's rect vs the element's content box, per side | `ancestor_overflow_clip` |
| `overflowing` | `scrollWidth/Height` vs `clientWidth/Height`, and text-node glyph rects vs the content box (redundant scroll overflow folds into the text culprit) | `content_overflow`, `text_overflow` |
| `overlapping` | paint-order candidates above the element intersected with its border box (top 3) | `overlapped_by_sibling` |
| `not_centered` | left/right + top/bottom gap asymmetry inside the parent content box (or viewport); an axis where the element overflows the container is skipped — that is an overflow problem | `off_center` |
| `wrong_size` | content box vs `expected` px; names the constraining property's cascade winner (selector + value + `!important`) | `size_driven_by_declaration` |
| `auto` | the ordered battery invisible → clipped → overflowing → overlapping → not_centered (+ wrong_size only when `expected` dimensions were given); the first tripped check becomes `symptom_detected`, other tripped checks still appear as lower-ranked culprits | — |

Scoring is fixed and documented (determinism is the contract): magnitudes ≤ 0.5px do not trip; confidence is `high` above 4px (boolean causes like `display:none` always rank first), `medium` in (1, 4], `low` in (0.5, 1]; ordering is detected-symptom first, then confidence, then magnitude.

**Output** — the JSON envelope, capped at ~6 KB (lowest-ranked culprits are dropped with `truncated: true`). Real captured run (a 234px child inside a 200px `overflow:hidden` wrapper):

```json
{
 "summary": "clipped: e1 <div#clipped> sticks out of clipping ancestor e2 <div#clip-wrap> (overflow:hidden) by 34px right",
 "symptom_detected": "clipped",
 "culprits": [
  {
   "rank": 1,
   "confidence": "high",
   "cause": "ancestor_overflow_clip",
   "plain": "e1 <div#clipped> sticks out of clipping ancestor e2 <div#clip-wrap> (overflow:hidden) by 34px right",
   "evidence": { "ancestor_uid": "e2", "ancestor_identity": "<div#clip-wrap>", "overflow": "hidden", "exceed_right": 34 }
  }
 ],
 "truncated": false
}
```

A healthy element is an answer too (real output): `"summary": "e3 <div#healthy> renders as expected within tolerances (5 checks run: invisible, clipped, overflowing, overlapping, not_centered)", "symptom_detected": "none", "culprits": []`. `wrong_size` without `expected` dimensions errors with `symptom "wrong_size" needs expected.width_px and/or expected.height_px — pass an expected size`.

## responsive_sweep

One verification payload, many viewports — the cure for "fixed on desktop, still broken on mobile". Runs a stored suite, inline assertions, or a `diagnose` probe at each viewport and returns a per-viewport matrix: PASS cells collapse to a verdict, FAIL cells carry the failed assertions with measured actuals and offending uids (never prose explanations), diagnose cells carry the detected symptom and top culprit. After every viewport change the page is settled deterministically (`document.fonts.ready` + double `requestAnimationFrame`) before measuring, and suites re-load per viewport so stored selectors re-resolve against each layout. The original viewport is restored in a `finally` (unless `restore_viewport: false`, or attach mode where puppeteer reports no viewport to restore — the summary says so).

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `viewports` | `{width, height, deviceScaleFactor?}[]` | 375x812, 768x1024, 1280x800, 1920x1080 | Viewports to sweep, max 8 per call |
| `run` | `{suite_id}` \| `{assertions}` \| `{diagnose}` | required (exactly one) | The payload to execute at every viewport |
| `restore_viewport` | boolean | `true` | Restore the pre-sweep viewport when done |

**Output** — the JSON envelope. Real captured sweep (an `equal_height` suite over a flex row that becomes a column under 800px; the 768 cell is trimmed):

```json
{
 "summary": "Suite 'cards-suite': PASS at 1280x800; FAIL at 375x812 (equal_height); FAIL at 768x1024 (equal_height)",
 "matrix": [
  {
   "viewport": "375x812",
   "verdict": "FAIL",
   "failed": [
    {
     "type": "equal_height",
     "id": "cards-equal",
     "measured": { "values": [40, 20], "unit": "px", "delta": 20, "tolerance_px": 1 },
     "offending_uids": ["e1", "e2"]
    }
   ]
  },
  […768x1024 FAIL cell elided]
  {
   "viewport": "1280x800",
   "verdict": "PASS"
  }
 ],
 "truncated": false
}
```

A viewport where the payload cannot run at all becomes an `ERROR` cell with a sanitized message — one broken viewport never aborts the sweep. Errors, quoted verbatim: more than 8 viewports throws `too many viewports (N) — max 8 per call; split the sweep into multiple calls with fewer viewports each`; zero or several payloads throws `run must carry exactly one payload: {suite_id} to re-run a stored suite, {assertions} for inline checks, or {diagnose} to probe one element per viewport`; an unknown suite fails fast with the same `SUITE_NOT_FOUND` message as `assert_visual`, before any viewport churn. Budget: FAIL cells' `failed` lists are halved until the envelope fits ~15 KB (`truncated: true`).

## capture_proof

Durable before/after evidence for one fix. Phase `before` records the broken state — an annotated screenshot plus, with `suite_id`, the suite's verdicts — into a named bundle under the artifacts dir (`<artifacts>/bundles/<bundle_id>/`); phase `after` re-captures and reports the **verdict delta** against the stored before-verdicts: "suite now PASS (was FAIL)" with the exact assertions that flipped. Use it to close the loop with humans: here is the before, the after, and the measured verdicts. Screenshots are written to disk and returned as file paths, never base64.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `phase` | `'before' \| 'after'` | required | Which side of the fix this capture is |
| `bundle_id` | string | required | Bundle name (1–64 chars: letters, digits, hyphens, underscores) — use the SAME id for before and after |
| `targets` | (uid \| `{selector}`)[] | `[]` | Elements to mark in the screenshot (deduped, max 25 after selector expansion); empty = auto-mark the top visible interactive/landmark elements |
| `suite_id` | string | — | Run this stored suite and store its verdicts with the phase (enables `verdict_delta` on after) |
| `note` | string ≤ 500 | — | Free-form caption, echoed in the summary |

**Output** — the JSON envelope. Real captured after-phase (the before phase had recorded the suite FAILing, then the fix landed):

```json
{
 "summary": "Bundle 'card-fix' AFTER captured; suite now PASS (was FAIL) — after flex-basis fix",
 "bundle_id": "card-fix",
 "phase": "after",
 "artifacts": [
  { "kind": "annotated_screenshot", "path": "/var/folders/…/artifacts/bundles/card-fix/after.png" }
 ],
 "truncated": false,
 "verdict_delta": {
  "before": "FAIL",
  "after": "PASS",
  "changed_assertions": [
   { "id": "cards-equal", "before": "FAIL", "after": "PASS" }
  ]
 }
}
```

The corresponding before-phase summary read `Bundle 'card-fix' BEFORE captured; suite FAIL — cards ragged before the flex fix`. An after-phase without a stored before warns (verbatim) `BUNDLE_PHASE_MISSING: no before phase captured — delta unavailable`; a before captured without `suite_id` warns `before phase has no stored verdicts (captured without suite_id) — delta unavailable`. Bundle ids failing the allow-list error with `Invalid bundle_id "…" — use 1-64 characters: letters, digits, hyphens, underscores (must start alphanumeric).` before the page is touched.

---

## Recommended debugging flow

1. **`connect`** — `{ url: "https://site.com" }` to launch, or `{ browserUrl: "http://127.0.0.1:9222" }` to attach to the user's real logged-in Chrome. Add `set_viewport` first thing if the bug is viewport-specific.
2. **Orient: `page_snapshot`** — get the uid-keyed tree. If the user described an element in words, ground it with **`find_elements`** (`{ text: "Get started" }`); if you are working from a screenshot or a coordinate, use **`annotated_screenshot`** / **`node_at_point`**; if a human is looking at the tab and offers to point, **`pick_element`** lets them click the element directly. On WordPress or an unfamiliar stack, run **`page_origins`** once so you know what you will be attributing against (and whether an optimizer bundle needs bypassing).
3. **What: `inspect_element`** — confirm the rendered reality: visibility verdict, real box, computed → used pairs. If the element is constrained/clipped/stacked by something above it, **`inspect_ancestors`** with the matching concern names the binding ancestor.
4. **Why: `explain_styles`** — usually with `property:` once you know what is wrong (`{ uid: "e5", property: "margin-bottom" }`). The WINNER's `→ file:line [granularity | origin — edit hint]` is the edit target; check the notes for INACTIVE declarations and `@media`/`@layer` context before editing.
5. **When the bug only happens on interaction** — "clicking does nothing" starts at **`get_listeners`** (who owns this event, or the honest "nobody does"); "it doesn't animate right" starts at **`explain_animations`** (`property:` set to what you expected to move); and when the static answers don't explain it, **`record_interaction`** on the trigger element captures the causal timeline of the interaction itself. When the bug lives in a state you have to *open* first — a menu, popup, modal, or revealed tab — **`interact`** drives the UI there and leaves it open so steps 3–4 can inspect the new state.
6. **When the issue is visual alignment, not a rule** — a glyph or icon that "looks off-center" even though the box model is symmetric goes to **`measure_element`**, which reports the sub-pixel text-ink-vs-content-box offset that box tools can't see. And for the genuinely bespoke read that no tool covers, **`evaluate`** runs your own JavaScript in the page.
7. **Verify: `style_diff`** — `{ uid: "e5", mode: "record" }`, apply the fix, `navigate` to reload (uids go stale, but the slot re-resolves by selector), then `{ mode: "compare" }`. The diff should contain exactly the properties you meant to change — nothing missing, nothing extra. For a behavioral fix, re-run `record_interaction` instead and compare timelines. For rendered-geometry claims ("now they're equal height"), state them as **`assert_visual`** assertions and get a measured PASS/FAIL — see [Verification & proof](#verification--proof-v07).

Related reading: [architecture.md](architecture.md) (how the deterministic pipeline works), [wordpress.md](wordpress.md) (origin resolution details).
