# Visionaire Engine — Technical Specification (v0.2)

> **Which rule, which file, which line — and why it wins.**

Visionaire Engine is an MCP server that deterministically translates a live rendered web page into structured context for LLMs debugging CSS, design, and WordPress issues. It answers the question no shipping tool answers: *why does this element look the way it does, and where do I edit to change it?*

---

## 1. Problem

When a user sees a visual problem in their browser and asks an LLM to fix it, the LLM gets either pixels (screenshots — no code linkage) or code (no rendering truth). Existing browser MCPs (Chrome DevTools MCP, Playwright MCP) ship accessibility snapshots that deliberately strip all styling; CSS debugging today means the LLM improvises `getComputedStyle` calls through a JS-eval escape hatch. The missing layer is **explanation and attribution**: cascade winner/loser verdicts, visibility causality, and mapping every winning declaration to its editable origin — a file:line, or (on WordPress) a database entity like an Elementor widget control.

## 2. Design principles

1. **No internal LLM. Ever.** Every output is deterministic: computed from CDP data plus closed rulesets. Deterministic means cacheable, diffable, testable, and host-agnostic.
2. **Fuzzy work belongs to the calling LLM.** Matching "the button under the hero" to an element is the caller's job. We make it cheap: uid-keyed snapshots, deterministic search tools, annotated screenshots whose mark numbers equal snapshot uids.
3. **Complement, don't compete.** We do not rebuild navigation/click/network tools. We emit element uids in the same idiom agents already know from a11y snapshots, so our output joins theirs.
4. **Honesty ladder.** Every attribution carries a granularity label: `line > file > db-entity > component > generated > unknown`. Never overpromise; degraded answers say so explicitly.
5. **Token-budgeted output.** A page census is 800–2,000 tokens. A per-element dossier is 300–800. Raw dumps are a bug, not a feature.
6. **Differentiate above raw data.** Raw computed styles will be commoditized (chrome-devtools-mcp issue #86). Our defensible layers are cascade verdicts, why-diagnostics, and WordPress origin resolution.

## 3. Architecture overview

```
┌────────────┐   stdio    ┌──────────────────────────────────────────┐
│ Any MCP    │◄──────────►│ visionaire-engine (Node, TypeScript)     │
│ client     │            │                                          │
│ (Claude    │            │  SessionManager ── puppeteer-core ── CDP │
│  Code,     │            │       │                                  │
│  Cursor…)  │            │  Pass 1: DOMSnapshot census (cheap)      │
└────────────┘            │  Pass 2: per-node why-dossier (deep)     │
                          │       │                                  │
                          │  Engines: cascade verdict · visibility · │
                          │   inactive decls · stacking · ancestors  │
                          │  Attribution: sheet registry · source    │
                          │   maps · WordPress origin resolver       │
                          │  Format: census · dossier (token-budget) │
                          └──────────────────────────────────────────┘
                                        │
                            launch or attach (real Chrome,
                            --remote-debugging-port / autoConnect)
```

**Two-pass extraction:**
- **Pass 1 (cheap, whole page):** `DOMSnapshot.captureSnapshot` with a whitelist of ~40 layout-affecting computed properties, `includePaintOrder`, `includeDOMRects`, `includeBlendedBackgroundColors`, `includeTextColorOpacities`. Produces a pruned **nested** tree (hierarchy is the strongest representation feature per D2Snap) with stable uids.
- **Pass 2 (deep, per suspect node):** `CSS.getMatchedStylesForNode` + `CSS.getComputedStyleForNode` + `DOM.getBoxModel`, then the cascade-verdict engine, inactive-declaration rules, and the attribution join.

**Chromium-only for v0.x.** CDP is the only mechanism that yields matched-rule source line/column (`getMatchedCSSRules` was removed from browsers; in-page CSSOM reading dies on CORS for CDN-hosted sheets).

## 4. Tool surface (MCP tools, v0.1)

| # | Tool | Purpose |
|---|------|---------|
| 1 | `connect` | Launch Chrome or attach to a running one (`browserUrl`), optionally navigate |
| 2 | `navigate` | Go to URL in the connected tab |
| 3 | `set_viewport` | Emulate viewport (responsive debugging) |
| 4 | `page_snapshot` | Pass-1 census: pruned nested tree with uids, geometry, visibility |
| 5 | `page_origins` | Stylesheet inventory + platform detection (WordPress, theme, plugins, builders, optimizers) |
| 6 | `inspect_element` | The "what": box model, filtered computed pairs, visibility verdict |
| 7 | `explain_styles` | **The wedge**: cascade winner/loser per property, with file:line + origin attribution |
| 8 | `inspect_ancestors` | Constraint-chain walk: which ancestor constrains width/position/overflow |
| 9 | `find_elements` | Deterministic search: by text, selector, role, region |
| 10 | `node_at_point` | x,y → element uid (screenshot-coordinate grounding) |
| 11 | `annotated_screenshot` | Screenshot with numbered marks == snapshot uids |
| 12 | `style_diff` | Record styles for a target, later compare → deltas only (verify-my-fix loops) |
| 13 | `pick_element` | Human-in-the-loop: DevTools-style hover highlight in the connected tab; the user clicks the broken element → uid |

### Tool specs

All element-taking tools accept a **TargetSpec**: exactly one of `uid` (from a prior snapshot), `selector` (CSS selector, first match), or `x`+`y` (viewport coordinates).

**`connect`** `{ mode?: 'launch'|'attach' = 'launch', url?: string, browserUrl?: string, headless?: boolean = false, width?: number, height?: number }`
Launch: find Chrome via `CHROME_PATH` env or standard macOS/Linux/Windows locations; launch via puppeteer-core. Attach: `puppeteer.connect({ browserURL })` (e.g. `http://127.0.0.1:9222`). On success: enable `DOM`, `CSS`, `Page`, `Overlay`, `DOMSnapshot` domains; attach the StylesheetRegistry (listens to `CSS.styleSheetAdded`). Returns status text incl. Chrome version, current URL. Re-`connect` tears down the previous session.

**`page_snapshot`** `{ budgetTokens?: number = 1500, scope?: TargetSpec, includeInvisible?: boolean = false }`
Returns the census (format §8.1). Scope limits the tree to a subtree. Pruning order when over budget: (1) drop invisible subtrees (keep count markers), (2) collapse chains of single-child wrapper divs with no layout role, (3) truncate deep subtrees breadth-first, always emitting `[N nodes pruned]` markers. Uids are stable for the lifetime of the page (registry keyed by CDP `backendNodeId`; cleared on navigation).

**`page_origins`** `{}`
One entry per stylesheet: sourceURL (or `<inline>` + owner id attr), rule count, byte size, origin classification (§7), source-map presence. Ends with a platform summary, e.g. `platform: WordPress 6.9 | theme: astra (child: astra-child) | builders: elementor | optimizers: none detected`. Detection is convention-based (§7.3) and works with zero WP cooperation.

**`inspect_element`** `{ ...TargetSpec, verbose?: boolean = false }`
The "what" dossier (§8.2): element identity, box model (content/padding/border/margin from `DOM.getBoxModel`), whitelisted computed values as **pairs** (authored-relevant computed value vs used value where they differ, e.g. `width: 50% → 342px`), visibility verdict (§6.2), layout context (display of self + parent, flex/grid role).

**`explain_styles`** `{ ...TargetSpec, property?: string }`
The "why" dossier (§8.3). With `property`: verdict for that property (and its shorthand family). Without: verdicts for every property that has ≥2 competing declarations or is authored (non-UA), capped at the token budget. Pipeline: `CSS.getMatchedStylesForNode` → cascade engine (§6.1) → inactive-declaration check (§6.3) → attribution join (§7) → dossier renderer.

**`inspect_ancestors`** `{ ...TargetSpec, concern?: 'width'|'height'|'position'|'overflow'|'stacking' = 'width' }`
Walks up the ancestor chain reporting, per ancestor, only the properties relevant to the concern (e.g. width: `width/max-width/box-sizing/padding/display/flex-basis`; overflow: `overflow-*`, clip; stacking: stacking-context creators §6.4). Output: one line per ancestor with uid, so the caller can drill into any of them.

**`find_elements`** `{ text?: string, selector?: string, role?: string, region?: {x,y,width,height}, visibleOnly?: boolean = true, limit?: number = 10 }`
Deterministic search primitives; criteria AND-combined. Text matching: case-insensitive substring on trimmed innerText. Returns compact lines: uid, tag.classes, text preview, bounds.

**`node_at_point`** `{ x: number, y: number }`
`DOM.getNodeForLocation` → uid + one-line identity + the full ancestor uid chain (so the caller can move up if the hit is a text wrapper).

**`annotated_screenshot`** `{ uids?: string[], region?: {x,y,width,height}, fullPage?: boolean = false }`
Screenshot via `Page.captureScreenshot` (clip for region). Marks: numbered boxes burned in for the given uids (default: top ~25 visible interactive/landmark elements from the last snapshot). Implementation: inject a temporary overlay `<div>`s via `Runtime.evaluate` before capture, remove after (simpler and more legible than `Overlay.highlightNode` for multiple marks). Legend text maps mark number → uid → identity. **Mark numbers ARE the uid numbers** (mark `17` = uid `e17`).

**`style_diff`** `{ ...TargetSpec, mode: 'record'|'compare', slot?: string = 'default' }`
`record`: store whitelisted computed values + box model for the target under `slot`. `compare`: re-read and emit only changed properties (`prop: old → new`). Slots survive navigation (keyed by slot name, re-resolved by selector when uid is stale).

**`pick_element`** `{ timeoutSeconds?: number = 60 }`
Human-in-the-loop grounding with zero extra install: `Overlay.setInspectMode({ mode: 'searchForNode' })` gives the already-connected tab a DevTools-style hover highlight; the user clicks the element that looks wrong; CDP fires `Overlay.inspectNodeRequested { backendNodeId }`. The tool resolves a uid, cancels inspect mode (also on timeout or error, always), and returns the element identity line + ancestor chain + a hint to call `explain_styles`. In a headless session it proceeds but prefixes a warning that no human can see the tab (synthetic `Input.dispatchMouseEvent` clicks still work, which is also how the happy path is e2e-tested; a human picker needs `connect { headless: false }`). This replaces the v1.1 "picker overlay" roadmap item.

## 5. Data model

### 5.1 Uids
`e1, e2, e3…` assigned in document order at first sight, keyed by CDP `backendNodeId` in a session-scoped registry. Same node → same uid across all tools until navigation clears the registry. This mirrors the ref idiom of Playwright MCP / chrome-devtools-mcp snapshots.

### 5.2 Granularity ladder
Every attribution is labeled with the best honest level:

| Level | Meaning | Example edit surface |
|---|---|---|
| `line` | authored file + line known | `themes/astra-child/style.css:104` |
| `file` | file known, line unreliable (minified, no map) | `plugins/foo/assets/app.min.css` |
| `db-entity` | origin is a database entity, not a file | `Elementor widget 4f2a1c → Advanced → Padding` |
| `component` | dev-mode framework attribution (data-attributes) | `src/components/Hero.tsx` |
| `generated` | generated/concatenated artifact — do not edit | `uploads/elementor/css/post-88.css` (+ true-source hint) |
| `unknown` | none of the above | raw selector + cssText still shown |

### 5.3 Loss reasons
`importance` (!important beat it) · `specificity` · `order` (source order, equal specificity) · `layer` (cascade layer) · `origin` (UA vs author vs injected) · `inline` (inline style beat it) · `inherited-distance` (closer inherited value wins).

## 6. Deterministic engines

### 6.1 Cascade verdict (`engine/cascade.ts`) — the wedge
CDP's `CSS.getMatchedStylesForNode` returns *all* matched rules (with selector specificity, source ranges, layers, media/container conditions), inline/attribute styles, and the inherited chain — but **not** which declaration wins. DevTools computes that client-side (`CSSMatchedStyles.ts` in devtools-frontend). We reimplement that logic:

1. **Collect declarations** in cascade-priority order for the target node:
   a. transitions/animations are out of scope for v0.1 (note in output if `cssKeyframesRules` present for the property);
   b. inline style (`inlineStyle`), c. matched rules — CDP returns `matchedCSSRules` ordered by ascending priority, so iterate **last→first**; d. attribute style (`attributesStyle`); e. inherited entries (`inherited[]`, nearest ancestor first) — **inheritable properties only** (maintain the standard inherited-property list: color, font-*, line-height, letter-spacing, text-align, text-transform, white-space, visibility, cursor, list-style-*, direction, quotes, orphans, widows, caption-side, border-collapse, border-spacing, empty-cells, word-*, tab-size).
2. **Expand shorthands** to longhands using a static shorthand map (margin, padding, border[-side], border-width/style/color, background, font, flex, flex-flow, gap, inset, overflow, place-*, grid-area/row/column, text-decoration, outline, list-style, columns, transition, animation). A longhand declaration and a shorthand covering it compete on the longhand's name. Track `fromShorthand`.
3. **Resolve per longhand property**: walk candidates; the winner is determined by, in order: (1) origin+importance per CSS 2.2/Cascade 5 (UA normal < author normal < author !important < UA !important; inline style sits at author level with highest specificity-equivalent, but author `!important` beats non-important inline), (2) cascade **layers** (unlayered author beats layered for normal declarations; reversed for `!important`), (3) **specificity** (use CDP's per-selector `specificity {a,b,c}` field when present — experimental — else compute with our own parser in `engine/specificity.ts`), (4) **source order** (later wins), and for inherited candidates, (5) **proximity** (nearer ancestor wins; any direct match beats any inherited).
4. **Emit** a `PropertyVerdict` per property: winner + losers each tagged with the *first decisive* loss reason, plus the computed value from `CSS.getComputedStyleForNode` for cross-checking. If our predicted winner's value ≠ computed value (modulo unit resolution), append a `verdict-uncertain` note rather than guessing — honesty over confidence.

Rules with non-matching media/container queries do not appear in `matchedCSSRules` (CDP pre-filters), so no media evaluation is needed in v0.1; the winning rule's `@media`/`@container`/`@layer` context IS reported in the dossier when present (`rule.media`, `rule.layers`, container queries).

### 6.2 Visibility decision tree (`engine/visibility.ts`)
Ordered checks; first hit wins (report status + cause + causing uid when applicable):
1. **detached** — node not in the flat tree / no layout object (no box in DOMSnapshot, no `getBoxModel`).
2. **display-none** — computed `display:none` on self, else walk ancestors; report the ancestor uid and (via a scoped `getMatchedStylesForNode` on that ancestor) the rule that sets it.
3. **visibility-hidden** — computed `visibility: hidden|collapse`.
4. **zero-size** — border-box area 0 and `overflow` not visible-with-children.
5. **opacity-zero** — effective opacity 0 (self or accumulated ancestor product).
6. **off-viewport** — bounds fully outside the layout viewport (report direction + distance; note "scrollable to" if within document bounds).
7. **clipped** — bounds fully outside the intersection of ancestor clip boxes (ancestors with `overflow` ≠ visible, `clip-path`, `contain: paint`, `content-visibility`); report the clipping ancestor uid.
8. **occluded** — probe center + 4 quarter-points via `DOM.getNodeForLocation`; if another element (not self/descendant/ancestor-with-transparent-bg) wins ≥3 probes, report the occluder uid. Cross-check with DOMSnapshot `paintOrder`.
9. **transparent-text** (text-bearing only) — text color alpha 0, or DOMSnapshot `textColorOpacities` ≈ 0, or blendedBackgroundColor == text color (invisible-ink).
10. else **visible**.

### 6.3 Inactive declarations (`engine/inactive.ts`)
Port of the idea behind Firefox's `inactive-css` rules: "you set it, but it does nothing because…". v0.1 ruleset (pure function over declarations + computed styles):
- `width/height` on non-replaced inline element → suggest `display:block|inline-block`
- `margin-top/bottom` on inline → same
- `vertical-align` on non-inline, non-table-cell
- flex item props (`flex-*`, `order`, `align-self`) when parent isn't flex/inline-flex (needs parent display, passed in)
- grid item props (`grid-*`, `justify-self`) when parent isn't grid
- `justify-content/align-items/gap/flex-direction` on non-flex/grid container
- `z-index` on `position:static` non-flex/grid item
- `top/right/bottom/left` on `position:static`
- `float` on flex/grid items
- `text-overflow: ellipsis` without `overflow:hidden` + `white-space:nowrap` (heuristic note)
- `position:sticky` without an inset property, or inside `overflow:hidden` ancestor (note-level)
Each finding: reason sentence + fix hint. Extensible table, one entry per rule.

### 6.4 Stacking contexts (`engine/stacking.ts`)
Closed ruleset for "is this element a stacking context / why is z-index ineffective": root; `position` ≠ static with z-index ≠ auto; `position: fixed|sticky`; flex/grid child with z-index ≠ auto; `opacity < 1`; `transform/filter/perspective/clip-path/mask/backdrop-filter` ≠ none; `isolation:isolate`; `mix-blend-mode` ≠ normal; `will-change` naming any of the above; `contain: layout|paint`. Used by `inspect_ancestors {concern:'stacking'}`: prints the stacking-context chain from the element to root and flags "z-index:9999 is scoped inside context created by e12 (transform) — cannot escape it".

### 6.5 Ancestor constraint walk (`engine/ancestors.ts`)
For a concern (width/height/position/overflow/stacking), walk self → root emitting one compact line per ancestor with only the concern-relevant computed properties, marking the **binding constraint** where detectable (e.g. first ancestor whose content-box width equals the element's outer width chain; `max-width` hit; flex-basis vs width).

## 7. Attribution

### 7.1 Stylesheet registry (`attribution/stylesheets.ts`)
Subscribe to `CSS.styleSheetAdded` from connect-time (CSS.enable replays existing sheets). Store `CSSStyleSheetHeader` per `styleSheetId`: `sourceURL`, `sourceMapURL`, `origin` (user-agent/injected/inspector/regular), `isInline`, `ownerNode` (backendNodeId). Lazily resolve the owner node's `id` **attribute** via `DOM.describeNode` — WordPress handles live there (`id="{handle}-css"`). `classify(sheet, selector?)` produces a `StyleOrigin` (granularity + label + edit surface), delegating to the WP resolver when WP markers are present.

### 7.2 The 3-hop join (rule → file:line)
1. `CSSProperty.range` / `CSSRule.style.range` → line/col in the sheet (0-based in CDP; present 1-based in output).
2. `styleSheetId` → header → `sourceURL` (the served file). For classic WordPress the served file IS the editable file → granularity `line`.
3. If `sourceMapURL` present: fetch (relative to sheet URL; support inline `data:` maps), decode with `@jridgewell/trace-mapping`, map to authored file:line (Sass partial, etc.) → granularity `line` with `via source map` note. Cache decoded maps per sheet. On any failure: fall back to hop-2 result with granularity `file` and note the failure.

### 7.3 WordPress origin resolver (`attribution/wordpress.ts`) — convention mode, zero WP cooperation
Pure functions over (sheet sourceURL, owner-node id attr, selector, document markers). Detection table (checked in order):

| Marker | Origin (kind) | Granularity | Edit surface |
|---|---|---|---|
| owner `<style id="wp-custom-css">` | `customizer-css` | db-entity | Appearance → Customize → Additional CSS (stored as `custom_css` post) |
| owner `<style id="global-styles-inline-css">` | `global-styles` | db-entity | Site Editor → Styles (theme.json / `wp_global_styles`) |
| owner id `wp-block-library-css` | `block-library` | file (core — don't edit; override instead) | |
| owner id `core-block-supports-inline-css` | `block-supports` | db-entity | per-block attributes in the post editor |
| owner id `{handle}-inline-css` | `inline-handle` | db-entity | `wp_add_inline_style('{handle}')` — theme/plugin options that print CSS |
| URL `…/wp-content/uploads/elementor/css/post-{id}.css` | `elementor-post` | generated→db-entity | Elementor editor for post {id}; selector `.elementor-element-{eid}` → widget `{eid}` |
| URL `…/uploads/elementor/css/global.css` | `elementor-global` | db-entity | Elementor → Site Settings |
| URL contains `/et-cache/` | `divi-generated` | generated | Divi builder for that post; suggest rebuilding cache |
| URL `…/wp-content/cache/autoptimize/…`, `…/cache/wp-rocket/…`, `…/cache/min/…` | `optimizer-bundle` | generated | re-inspect with bypass: `?nowprocket` (WP Rocket), `?ao_noptimize=1` (Autoptimize) — emit `bypassHint` |
| URL `…/wp-content/themes/{slug}/…` | `theme` (or `child-theme` if a second theme slug is also present on the page and this one hosts `style.css` with the smaller footprint — v0.1: just report slug) | line/file | edit that file |
| URL `…/wp-content/plugins/{slug}/…` | `plugin` | line/file | edit that file (warn: plugin updates overwrite — prefer overriding) |

Page-level WP detection (for `page_origins`): any `/wp-content/` or `/wp-includes/` URL, `meta name="generator" content="WordPress x.y"`, body classes (`elementor-page`, `et_divi_theme`). Builders detected per table. Everything here is testable as pure functions with fixture metadata — no browser required.

### 7.4 Framework component attribution (opportunistic)
If the element carries known dev-mode markers, report them at granularity `component`: `data-inspector-*` (code-inspector-plugin), `data-oid` (Onlook), `data-v-*` (Vue scoped styles — reports the component association, not a file), `data-locatorjs-*`. Detection only; no build-tool integration in v0.1.

## 8. Output formats (all plain text, token-budgeted)

### 8.1 Census (`format/census.ts`)
```
page: https://example.com "Example Domain"  viewport 1280x800  (WordPress 6.9, theme astra, builder elementor)
e1 body 1280x2400
  e2 header.site-header 1280x96 @(0,0) sticky z:100
    e3 a.logo "Acme" 120x40 @(24,28)
    e4 nav 400x40 @(856,28) flex [5 links]
  e5 main 1280x2100 @(0,96)
    e6 section.hero.elementor-element-4f2a1c 1280x520 grid
      e7 h1 "Build faster" 600x120 @(340,180)
      e8 a.btn.primary "Get started" 180x48 @(550,340)
      [2 invisible nodes hidden: e9(display:none) e10(off-viewport)]
  [38 nodes pruned: budget — narrow with scope or find_elements]
```
Per node: uid, tag, up to 3 salient classes, id attr when present, text preview ≤ 30 chars, `WxH @(x,y)`, layout hints only when noteworthy (flex/grid/sticky/fixed/absolute, z-index on non-statics). Indentation = hierarchy. Invisible nodes hidden by default but *counted with reasons*.

### 8.2 What-dossier (`inspect_element`)
```
element e8 <a.btn.primary> "Get started"  — visible, clickable
box: content 180x48 @(550,340) | padding 12 28 12 28 | border 0 | margin 0 0 24 0
layout: inline-flex (parent e6: grid; this item: row 2, col auto)
computed (authored-relevant):
  font: 16px/1.5 "Inter", 600 | color #fff | background #6c5ce7
  width auto → 180px | border-radius 8px | box-shadow (1 layer)
visibility: visible — paints on top at center (paintOrder 41)
```

### 8.3 Why-dossier (`explain_styles`)
```
element e8 <a.btn.primary> "Get started"
why margin-bottom = 24px:
  WINNER  .hero-cta .btn { margin-bottom: 24px }  spec(0,2,0)
    → themes/astra-child/style.css:104  [line | theme: astra-child — edit this line]
  lost (specificity)  .btn { margin-bottom: 12px }  spec(0,1,0)
    → plugins/elementor/assets/css/frontend.min.css  [file | plugin: elementor — minified, no map]
why color = #fff:
  WINNER  inline style attribute
    → [db-entity | Elementor widget 4f2a1c on post 88 → Style → Text Color]
  lost (inline)  .btn.primary { color: #f5f5f5 }  spec(0,2,0) → …/style.css:98
notes:
  - 'width: 100%' at style.css:106 is INACTIVE — inline-level element; add display:block or use inline-block
  - winner for margin-bottom sits inside @media (min-width: 768px)
```
Format rules: winner first; losers collapsed to one line each with decisive loss reason; every rule gets `→ location [granularity | origin — edit hint]`; inactive findings and context notes (`@media`, `@layer`, container) go under `notes:`. Budget cap: with no `property` filter, order verdicts by (competing-declaration count desc, then authored-over-UA), truncate with `[N more properties — ask with property:]`.

## 9. Degradation & honesty rules
- Attribution always emits its granularity label; `unknown` still shows selector + cssText + sheet URL.
- Cascade verdict cross-checks against computed value; on mismatch emit `verdict-uncertain (computed disagrees)` — never silently guess.
- Experimental CDP fields (`specificity`, `layers`, `paintOrder`, blended colors) get feature-detection: absent field → fallback path (own specificity parser; skip paint-order checks) + one-line capability note in output.
- Optimizer bundles: classify, emit `bypassHint`, and (v0.1) tell the caller to re-`navigate` with the bypass query param.

## 10. CDP dependency policy
Pin `devtools-protocol` types via puppeteer-core. A schema smoke test (`test/cdp-contract.test.ts`, part of e2e) asserts the shape of `getMatchedStylesForNode` / `DOMSnapshot.captureSnapshot` responses on the real Chrome so a Chrome update that breaks assumptions fails loudly, not silently.

## 11. Project layout & module contracts

```
src/
  index.ts                 # bin entry: stdio transport, shutdown
  server.ts                # createServer(session): McpServer — registers all tools; owns connect/navigate/set_viewport
  session.ts               # SessionManager; findChromeExecutable()
  types.ts                 # shared interfaces (written; do not modify without integrator sign-off)
  uid.ts                   # UidRegistry + resolveTarget(ctx, target) (written)
  tools/
    page-snapshot.ts       # export const pageSnapshotTool: ToolDef
    page-origins.ts        # export const pageOriginsTool: ToolDef
    inspect-element.ts     # export const inspectElementTool: ToolDef
    explain-styles.ts      # export const explainStylesTool: ToolDef
    inspect-ancestors.ts   # export const inspectAncestorsTool: ToolDef
    find-elements.ts       # export const findElementsTool: ToolDef
    node-at-point.ts       # export const nodeAtPointTool: ToolDef
    annotated-screenshot.ts# export const annotatedScreenshotTool: ToolDef
    style-diff.ts          # export const styleDiffTool: ToolDef
  engine/
    cascade.ts             # computeCascade(matched: Protocol.CSS.GetMatchedStylesForNodeResponse, computed: Map<string,string>, opts?): PropertyVerdict[]
    specificity.ts         # computeSpecificity(selector: string): Specificity; compareSpecificity(a,b): number
    inactive.ts            # findInactiveDeclarations(decls, computed, parentDisplay?): InactiveFinding[]
    visibility.ts          # assessVisibility(ctx, node: ResolvedNode): Promise<VisibilityReport>
    stacking.ts            # stackingContextReason(computed: Map<string,string>): string | undefined
    box-model.ts           # getBoxSummary(ctx, node): Promise<BoxSummary>
    ancestors.ts           # walkAncestors(ctx, node, concern): Promise<AncestorLine[]>
  attribution/
    stylesheets.ts         # class StylesheetRegistry implements StylesheetRegistryLike
    sourcemaps.ts          # resolveAuthoredPosition(sheet, line, col): Promise<AuthoredPos | undefined>
    wordpress.ts           # resolveWpOrigin(meta: WpSheetMeta): WpOrigin | undefined; detectPlatform(sheets, docMarkers): PlatformInfo
  format/
    census.ts              # renderCensus(root: SnapshotNode, page: PageMeta, budgetTokens): string
    dossier.ts             # renderWhyDossier(input: WhyDossierInput): string; renderWhatDossier(input: WhatDossierInput): string
scripts/demo.ts            # connect → fixture/URL → census + one dossier, printed
test/
  cascade.test.ts, inactive.test.ts        # pure-logic tests on constructed CDP payloads
  wordpress.test.ts                        # pure resolver tests on fixture metadata
  e2e.test.ts                              # real Chrome against test/fixtures/*.html (skips if no Chrome)
  fixtures/{cascade,wordpress,visibility}.html + fixtures/css/*.css
```

Conventions: ESM + NodeNext (**relative imports must use `.js` extension**), strict TS, no default exports, token estimate = `Math.ceil(chars / 4)`.

## 12. Testing strategy
1. **Pure-logic unit tests** (no browser): cascade verdicts on hand-built `getMatchedStylesForNode` payloads (specificity beats order; !important flips; inline vs !important; shorthand expansion; inherited proximity), inactive rules, WP resolver table, specificity parser.
2. **E2E on real Chrome** (auto-skip if `findChromeExecutable()` fails): fixtures with *known* rule line numbers; assert `explain_styles` names the right winner, right file, right line; visibility fixture asserts each status; WP fixture asserts platform detection + Elementor widget extraction.
3. **CDP contract smoke test**: assert presence/shape of the experimental fields we rely on.
4. **Seeded-bug benchmark (`bench/`)**: fixture pages each seeding one known visual bug, with an expected-answer manifest (property, winning rule location, loss reason / origin markers). The deterministic runner (`npm run bench`) drives the real tools against each case and scores whether the engine's output names the true cause, plus the token cost of the context produced. This is the regression suite for explanation quality; the LLM-in-the-loop half (does the context lift model diagnosis accuracy) remains v1.2.

## 13. Roadmap
- **v0.1 (shipped):** the first 12 tools, Chromium launch/attach, WP convention mode.
- **v0.2 (this increment):** `pick_element` click-to-pick; the deterministic benchmark harness (`bench/`); minification-aware granularity degradation; census platform header.
- **v0.3:** source-map hardening, stacking/z-index explainer depth, `@layer` verdict edge cases, style_diff across viewports.
- **v1.1:** WordPress companion plugin (~6 Abilities on the official mcp-adapter, WP 6.9+): enqueue registry, `_elementor_data` control resolution, Site-Editor template-override detection, staleness checks. Needs a live WP 6.9 test site.
- **v1.2:** LLM-in-the-loop benchmark (does the context lift diagnosis accuracy — the marketing artifact); Firefox/BiDi investigation.
