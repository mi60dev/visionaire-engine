# Architecture

How visionaire-engine turns a rendered page into deterministic, attributable answers — and why it is built this way.

Companion docs: [tools.md](tools.md) (tool-by-tool reference) · [wordpress.md](wordpress.md) (WP origin resolution) · [development.md](development.md) (building and testing) · [../SPEC.md](../SPEC.md) (design spec). Where this document and SPEC.md disagree, this document describes the shipped code.

## The core thesis

The server is a **deterministic explanation layer** between a real Chrome and a calling LLM. There is no model inside: every byte of output is computed from Chrome DevTools Protocol (CDP) data plus closed rulesets — a cascade comparator, a visibility decision tree, an inactive-declaration table, a WordPress detection table. Deterministic means the output is cacheable, diffable, unit-testable against fixed CDP payloads, and identical regardless of which LLM is calling.

The division of labor is deliberate:

- **The engine does the exact work.** Which declaration wins `margin-bottom` and why the others lost; which ancestor clips this element; which file and line (or which Elementor widget) the winning rule lives in. These questions have single correct answers, and an LLM that improvises them from `getComputedStyle` dumps gets them wrong expensively.
- **The calling LLM does the fuzzy work.** Matching *"the button under the hero looks off"* to an element requires world knowledge the engine doesn't have and shouldn't fake. The engine makes that grounding cheap instead: uid-keyed page censuses, deterministic search (`find_elements`), coordinate lookup (`node_at_point`), and screenshots whose burned-in mark numbers equal snapshot uid numbers.

## Why CDP, not an injected JS library

An in-page script is the obvious alternative, and it cannot do this job:

1. **`getMatchedCSSRules` was removed from browsers** (Chrome dropped it in 2017; it was never standardized). There is no web-platform API that answers "which rules matched this element, with source positions". Only the DevTools protocol (`CSS.getMatchedStylesForNode`) exposes matched rules with selector text, per-selector specificity, `@layer`/`@media` context, and character-exact source ranges.
2. **CORS kills CSSOM reading for CDN stylesheets.** Reading `document.styleSheets[i].cssRules` from page JS throws `SecurityError` for any cross-origin sheet served without CORS headers — which describes most CDN-hosted, optimizer-bundled, and plugin CSS in the wild. CDP sits outside the page and sees everything.

CDP also means zero site cooperation (no build step, no plugin, no snippet) and near-zero page perturbation. The cost is being **Chromium-only for v0.x**. Two of the CDP fields relied on (`specificity` on selectors, `layers` on rules) are experimental; the code feature-detects them (falling back to its own specificity parser in `src/engine/specificity.ts`) and a contract smoke test (the "CDP contract smoke" block in `test/e2e.test.ts`) fails loudly if a Chrome update changes the core shapes — the two experimental fields are logged as present/absent rather than failed, since the fallbacks cover them.

## System overview

```
┌────────────┐  stdio   ┌───────────────────────────────────────────────────────┐
│ MCP client │◄────────►│ visionaire-engine (Node, TypeScript, no LLM inside)   │
│ (Claude    │          │                                                       │
│  Code,     │          │  index.ts ── stdio transport, shutdown                │
│  Cursor…)  │          │  server.ts ─ registers 13 tools                       │
└────────────┘          │  session.ts ─ SessionManager ── puppeteer-core ── CDP │
                        │       │            │                                  │
                        │  uid.ts (registry) │  attribution/stylesheets.ts      │
                        │                    │  (CSS.styleSheetAdded listener)  │
                        │  tools/  ──────────┼────────────────────────────      │
                        │   Pass 1: page_snapshot → DOMSnapshot census          │
                        │   Pass 2: inspect_element / explain_styles /          │
                        │           inspect_ancestors → per-node dossiers       │
                        │       │                                               │
                        │  engine/      cascade · specificity · inactive ·      │
                        │               visibility · stacking · box-model ·     │
                        │               ancestors                               │
                        │  attribution/ stylesheets · sourcemaps · wordpress    │
                        │  format/      census · dossier   (token-budgeted)     │
                        └───────────────────────────────────────────────────────┘
                                          │
                              launch Chrome (headless or visible)
                              or attach via --remote-debugging-port
```

## The two-pass extraction pipeline

Extracting everything about every node would be both slow (matched-styles is a per-node CDP call) and useless (a raw dump blows any context window). So extraction is split by cost:

**Pass 1 — census (`page_snapshot`, cheap, whole page).** One `DOMSnapshot.captureSnapshot` call returns the entire flattened DOM plus, per laid-out node, a whitelist of 57 layout-affecting computed properties (`COMPUTED_WHITELIST` in `src/types.ts`), paint order, and geometry — in one round trip. `src/tools/page-snapshot.ts` decodes CDP's columnar format into a nested tree (hierarchy is the strongest structural signal an LLM can get), assigns uids in document order, tags cheap visibility verdicts (`display:none`, `visibility:hidden`, `zero-size`, `off-viewport`) and layout hints (`flex`, `grid`, `sticky z:100`), and hands the tree to the census renderer for budget pruning. The census header line carries a platform suffix — `(WordPress 6.9, theme astra, builder elementor)` — when platform detection (`detectPlatform`, the same convention-based detection `page_origins` uses, fed by one extra `Runtime.evaluate` for the generator meta and body classes) finds something; non-platform pages get no suffix. Two experimental snapshot params (`includeBlendedBackgroundColors`, `includeTextColorOpacities`) are requested optimistically and retried without on older Chrome.

**Pass 2 — dossier (deep, per suspect node).** Once the caller has picked a suspect (by uid, selector, or coordinates), the expensive per-node calls run: `CSS.getMatchedStylesForNode` + `CSS.getComputedStyleForNode` feed the cascade engine (`explain_styles`); `DOM.getBoxModel` and the visibility tree feed `inspect_element`; a single in-page `Runtime.callFunctionOn` collects self-to-root computed facts for `inspect_ancestors`. The results flow through the attribution join and out through the dossier renderers.

The census exists so the LLM spends Pass-2 budget only on nodes worth explaining.

## Module map

```
src/
  index.ts        bin entry: stdio transport, SIGINT/SIGTERM shutdown.
                  stdout is the MCP protocol; all diagnostics go to stderr.
  server.ts       createServer(session): registers connect / navigate /
                  set_viewport inline (their zod schemas live here) plus the
                  ten ToolDefs from tools/. Wraps every handler so errors
                  come back as isError text, never a crashed server.
  session.ts      SessionManager: find Chrome (CHROME_PATH or per-OS paths),
                  launch via puppeteer-core or attach to a running browser,
                  enable the CDP domains (DOM, Page, CSS, DOMSnapshot,
                  Overlay), wire uid + stylesheet registries to navigation.
  types.ts        every shared contract: TargetSpec, ToolDef, DeclarationInfo,
                  PropertyVerdict, VisibilityReport, StyleOrigin, the
                  COMPUTED_WHITELIST, estimateTokens (chars / 4).
  uid.ts          UidRegistry (backendNodeId → e1, e2, …) and
                  resolveTarget(uid | selector | x,y → live node).

  tools/          one file per MCP tool; thin orchestration only — resolve the
                  target, call CDP, run engines, join attribution, render.
    page-snapshot.ts      Pass-1 census
    page-origins.ts       stylesheet inventory + platform detection
    inspect-element.ts    "what" dossier (box, computed pairs, visibility)
    explain-styles.ts     "why" dossier — the wedge
    inspect-ancestors.ts  constraint-chain walk
    find-elements.ts      deterministic search (text/selector/role/region)
    node-at-point.ts      x,y → uid + ancestor chain
    annotated-screenshot.ts  screenshot, mark numbers == uid numbers
    style-diff.ts         record/compare slots for verify-my-fix loops

  engine/         pure(ish) decision logic — the deterministic core
    cascade.ts      per-longhand winner/loser resolution (see below)
    specificity.ts  selector specificity parser — fallback for the
                    experimental CDP field; handles :is/:not/:where/:host,
                    namespaces, escapes
    inactive.ts     "you set it but it does nothing" rule table (Firefox
                    inactive-css idea): width on inline, flex props under a
                    non-flex parent, z-index on static, sticky without inset…
    visibility.ts   the 10-step decision tree (see below)
    stacking.ts     closed ruleset: does this computed-style map create a
                    stacking context, and why
    box-model.ts    DOM.getBoxModel quads → content/padding/border/margin
                    summary (bounding-box approximation under transforms)
    ancestors.ts    self→root walk emitting concern-relevant facts per
                    ancestor and flagging the binding constraint

  attribution/    "which editable thing produced this rule"
    stylesheets.ts  StylesheetRegistry — listens to CSS.styleSheetAdded from
                    connect time, caches CSSStyleSheetHeaders, lazily resolves
                    owner-node id attributes (WordPress handles live there:
                    id="{handle}-css"), classifies sheets into StyleOrigins
    sourcemaps.ts   fetch + decode source maps (@jridgewell/trace-mapping),
                    cached per sheet, 3s timeout, any failure → undefined
    wordpress.ts    pure convention-mode resolver: ordered detection table
                    from owner ids and /wp-content/ URL shapes → Customizer,
                    Global Styles, Elementor post/widget, theme, plugin,
                    optimizer bundles with bypass hints; plus page-level
                    platform detection

  format/         plain-text renderers, the product's face
    census.ts       nested tree renderer with the three-stage budget pruner
    dossier.ts      renderWhyDossier / renderWhatDossier — winner-first
                    verdict blocks, "→ location [granularity | origin]" lines
```

The pure engines (`cascade`, `specificity`, `inactive`, `stacking`) and `attribution/wordpress.ts` take data, not a browser — cascade verdicts are unit-tested on hand-built `getMatchedStylesForNode` payloads, and the WP resolver on fixture metadata, with no Chrome in the loop. (`visibility`, `ancestors`, and `box-model` drive CDP directly and are exercised by the e2e suite instead.)

## The cascade verdict algorithm

`src/engine/cascade.ts` reimplements what DevTools computes client-side (CDP returns all matched rules but not which declaration wins). At a readable altitude:

**1. Collect candidates** from the `CSS.getMatchedStylesForNode` response in ascending cascade priority, each stamped with a monotonic collection index (later index wins order ties):

1. `attributesStyle` (presentational attributes like `<td width>`)
2. `matchedCSSRules` in CDP array order — CDP already orders them by ascending priority, so the array index *is* the source-order tiebreak
3. `inlineStyle` (the `style=""` attribute)
4. `inherited[]` entries, nearest ancestor first (distance 1, 2, …), each contributing its matched rules and inline style — **inheritable longhands only** (a fixed inherited-property list; custom properties always inherit)

**2. Expand shorthands to longhands**, because competition happens per longhand. When CDP already split the declaration (`longhandProperties`), those values win; otherwise a static shorthand map is used, with the raw shorthand value carried and `fromShorthand` recorded (dossiers render `(from padding)`). Two quirks handled here:

- *Chrome's synthetic longhands:* Chrome appends a synthetic normalized entry (no `text`, no `range`) after **every** authored declaration. Letting it through would overwrite the authored entry and lose the source range — i.e. the file:line. Synthetics whose property was already covered by an authored declaration in the same block are dropped.
- *Within one block*, a later declaration beats an earlier one for the same longhand — unless the earlier one was `!important` and the later one isn't.
- The static map sends `background` to `background-color` only — a deliberate v0.1 simplification (only the color channel of that family gets verdicts from a `background:` shorthand).

**3. Resolve per longhand** with a single comparator, criteria in order:

1. **Inherited proximity first** — any declaration on the element itself beats any inherited one, and nearer ancestors beat farther ones. This deviates from SPEC §6.1 (which lists proximity last) on purpose: inheritance is defaulting, not cascade, and "any direct match beats any inherited" is only satisfiable when proximity is decided before importance — a direct normal declaration must beat an ancestor's `!important` one.
2. **Origin + importance buckets**: UA normal < author normal < inline normal < author `!important` < inline `!important` < UA `!important`. Injected/inspector sheets bucket with author.
3. **Cascade layers**: unlayered beats layered for normal declarations, reversed for `!important`. When two *different* layer chains compete, CDP doesn't expose `@layer` statement order, so the code compares chains lexicographically as a deterministic proxy (later chain ≈ later-declared) — exact for unlayered-vs-layered, approximate between two named layers. This is a documented v0.1 limitation.
4. **Specificity** — CDP's experimental per-selector field when present, else the in-house parser.
5. **Source order** — the collection index; later wins.

**4. Emit a `PropertyVerdict`**: the winner, plus each loser tagged with the *first decisive* criterion it lost on — `inherited-distance`, `importance`, `origin`, `inline`, `layer`, `specificity`, or `order`.

**5. Cross-check against reality.** Each verdict carries the value from `CSS.getComputedStyleForNode`. The winner's value differing from computed is usually just resolution (`50%` → `342px`), so that alone doesn't trip anything; but when a *different* candidate's value matches the computed value exactly, the prediction is suspect and the verdict gets `uncertain: true`, rendered as a `verdict-uncertain (computed disagrees)` note. Honesty over confidence — the engine flags, never silently guesses. Animations/transitions are out of scope in v0.1; if `@keyframes` touch the queried property, a note says the verdict reflects the static cascade.

Real output from the bundled fixture (`npm run demo`), trimmed:

```
element e5 <a.btn> "Get started"
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
notes:
  - 'margin-bottom: 24px' at theme.css:10 is INACTIVE — vertical 'margin-bottom' has no effect on a non-replaced inline element; add display:block or display:inline-block
  - winner for outline-color sits inside @layer fixture
```

After resolution, `explain_styles` runs the **attribution join** on every winner and loser: `styleSheetId` → registry header → origin classification (WordPress resolver first, then inline/URL/constructed fallbacks), and — when the sheet has a source map and the rule has a range — the authored position. Winners also pass through the inactive-declaration table, which is why the fixture can say "you won the cascade, and it still does nothing".

## The visibility decision tree

`src/engine/visibility.ts` answers "why can't I see it" with ordered checks — first hit wins, and the answer names the causing element's uid where there is one. One in-page `callFunctionOn` gathers computed facts for the element and its whole ancestor chain in a single round trip; only occlusion probing stays protocol-side.

1. **detached** — not connected to the document / no layout object.
2. **display-none** — on self or an ancestor; the causing node gets a scoped `getMatchedStylesForNode` so the report can say *which rule* set it (`set by .mobile-only at theme.css:88`), best-effort.
3. **visibility-hidden** — attributes the *outermost* ancestor carrying the same `hidden`/`collapse` value (visibility inherits).
4. **zero-size** — border-box area 0, unless `overflow: visible` and a child actually paints.
5. **opacity-zero** — effective opacity (product over self + ancestors) ≈ 0; names the ancestor with literal `opacity:0` when there is one.
6. **off-viewport** — fully outside the layout viewport; reports direction, distance, and whether scrolling can reach it (`scrollable to (scroll down 640px)` vs `not reachable by scrolling`).
7. **clipped** — running intersection of ancestor clip boxes (`overflow` ≠ visible, `clip-path`, `contain: paint/strict/content`, `content-visibility: hidden`) leaves nothing of the element; names the clipping ancestor.
8. **occluded** — probes the center plus four quarter-points via `DOM.getNodeForLocation` (with `ignorePointerEventsNone: true`, because a `pointer-events:none` overlay still visually covers you). Hits on self/descendants are benign; so are ancestors with fully transparent backgrounds. If ≥ 3 of the probes land on an occluder, the report names the most-hit one.
9. **transparent-text** (text-bearing elements only) — text color alpha 0, or text color exactly equals a non-transparent background color ("invisible ink").
10. else **visible**.

The same tree serves three tools: `inspect_element` always reports it, `explain_styles` prepends it only when the element is *not* visible (it changes everything about the diagnosis), and Pass 1 uses a cheap four-status subset (checks 2, 3, 4, 6 from snapshot data alone) for the census.

## Attribution: the honesty ladder and degradation rules

Every attributed rule carries a granularity label from a fixed ladder — `line > file > db-entity > component > generated > unknown` — meaning "this is the best honest answer, and here is how good it is":

| Label | Meaning | Example |
|---|---|---|
| `line` | authored file + line known | `themes/astra-child/style.css:104` |
| `file` | file known, line unreliable | minified sheet with no source map; source map present but unresolvable |
| `db-entity` | origin is a database entity, not a file | `Global Styles — Site Editor → Styles` |
| `component` | dev-mode framework markers | *(defined in types; not yet produced in v0.1)* |
| `generated` | build artifact — do not edit | `uploads/elementor/css/post-88.css` + true-source hint |
| `unknown` | none of the above | selector + location still shown |

Degradation is always explicit, never silent:

- Source-map resolution failing (bad URL, timeout, no mapping for the range) drops `line` → `file` and appends `(source map unresolved)` to the edit hint. Sheet-relative and inline `data:` maps are supported; decoded maps are cached per sheet, and a failed load is cached too so it isn't refetched per declaration.
- A sheet that looks minified (`.min.` in the filename, or a large payload packed into very few lines) and has **no** source map drops `line` → `file` with the bracket reading `minified, no map` — a line number into minified CSS would be noise, not information. This applies uniformly: generic URL sheets and WordPress theme/plugin files alike (`[file | plugin: elementor — minified, no map]`).
- User-agent, injected, and inspector sheets classify as `unknown` — there is nothing editable behind them, and the label says what they are.
- Constructed stylesheets (`CSSStyleSheet` objects, typical of CSS-in-JS in production) classify as `unknown` with a hint about what they probably are.
- WordPress `generated` origins carry the pointer to the real edit surface (the Elementor editor, the Divi builder) and, for optimizer bundles, a `bypassHint` query param (`?nowprocket`, `?ao_noptimize=1`) so the caller can re-navigate and see the un-bundled truth.
- Experimental CDP fields are feature-detected: missing `specificity` → own parser; missing `parentLayoutNodeId` → in-page fallback probe; snapshot extras rejected by older Chrome → retried without.

The same honesty rule applies to verdicts (`verdict-uncertain`) and to budget pruning (`[38 nodes pruned: …]`, `[4 more properties — ask with property:]`): the output always says what it is *not* telling you.

## uid lifecycle

Uids are the currency between tools, and they follow the ref idiom agents already know from Playwright MCP / chrome-devtools-mcp snapshots.

- **Assign on sight.** `UidRegistry.assign(backendNodeId)` returns `e{n}` with a monotonic counter, keyed by CDP `backendNodeId`. `page_snapshot` builds pre-order, so numbering follows document order — but *any* tool that touches a node registers it: `find_elements` matches, `node_at_point` hits, occluders and clipping ancestors named by the visibility engine, ancestors in `inspect_ancestors`, "inherited from e12" sources in `explain_styles`. A uid minted anywhere is valid everywhere.
- **Stable per node.** The same `backendNodeId` always maps to the same uid; repeat sightings just refresh the cached tag/class metadata. Mark number 17 on an annotated screenshot is uid `e17`, always.
- **Cleared on navigation.** `backendNodeId`s (and `styleSheetId`s) are per-document, so a main-frame `Page.frameNavigated` clears both registries. A stale uid produces an actionable error ("take a fresh page_snapshot"), not a wrong element.

The stylesheet registry needs one extra trick on navigation. `frameNavigated` can arrive *after* Chrome has already replayed `CSS.styleSheetAdded` for the new document's sheets, so a bare `clear()` might wipe fresh entries. Instead, `session.ts` clears and then toggles `CSS.disable` → `CSS.enable`, which makes Chrome re-emit `styleSheetAdded` for every live sheet — the registry converges no matter which order the events landed in. That handler's toggle is fire-and-forget (it can't be awaited inside an event callback), which leaves a small race: a navigation the server didn't initiate (a JS redirect, a user clicking a link in an attached browser) could momentarily leave the registry partially populated if a tool call arrives mid-toggle. For the navigation path the server *does* own, `SessionManager.navigate()` closes the race by running a second, awaited toggle after `page.goto` resolves — any tool call that follows a `navigate` sees a fully populated registry.

## Token budgeting

Raw dumps are treated as bugs. Every renderer is budgeted with the same estimator (`estimateTokens = ceil(chars / 4)`), and truncation is always marked in the output. The real numbers in v0.1:

| Output | Budget | Where |
|---|---|---|
| `page_snapshot` census | **1500** default, caller-tunable via `budgetTokens` | `src/tools/page-snapshot.ts` |
| `explain_styles` why-dossier | **800** (`DOSSIER_BUDGET_TOKENS`); `property:`-filtered calls are never truncated | `src/tools/explain-styles.ts` |
| `inspect_ancestors` | **800** (`MAX_TOKENS`) | `src/tools/inspect-ancestors.ts` |
| `page_origins` | **1800** (`BUDGET_TOKENS`), drops smallest file sheets first | `src/tools/page-origins.ts` |
| `style_diff` compare | **800** (`DIFF_BUDGET_TOKENS`) | `src/tools/style-diff.ts` |
| `find_elements` | count-capped: `limit` default 10, max 100 | `src/tools/find-elements.ts` |

Two of these have real pruning strategies rather than plain truncation:

- **Census** (`src/format/census.ts`), in escalating stages until the budget fits: (1) collapse invisible nodes into count brackets, then drop their per-node reasons; (2) splice out chains of single-child wrapper `div`/`span`s with no id, ≤ 1 class, no text, and no layout role; (3) remove the deepest tree level, repeatedly — leaves go first, page structure survives. Every removal leaves a marker (`[5 links]`, `[38 nodes pruned: budget — narrow with scope or find_elements]`) telling the caller both what's missing and how to get it.
- **Why-dossier**: verdicts are ordered by usefulness (competing-declaration count desc, then authored-over-UA, then name) and added one at a time, re-rendering until the next one would blow the budget; the remainder becomes `[N more properties — ask with property:]`. The budget spends itself on the properties most likely to be the bug.

The philosophy: a budget forces the output to be an *explanation*, ranked and pre-digested, instead of a data transfer. The caller can always drill down — `scope` on the census, `property:` on the dossier, uids everywhere — so nothing pruned is ever more than one cheap call away.
