# Development guide

Building, testing, and extending visionaire-engine. For what the tools do, see
[tools.md](tools.md); for how the pipeline works internally and the
authoritative design reference, see [architecture.md](architecture.md).

## Prerequisites

- **Node ≥ 20** (`engines` field in `package.json`).
- **Chrome or Chromium installed.** The project depends on `puppeteer-core`,
  which does *not* download a browser. `findChromeExecutable()` in
  `src/session.ts` looks in `CHROME_PATH` first, then standard macOS / Windows /
  Linux install locations. E2E tests auto-skip when no Chrome is found.

### Why the dependency majors are what they are

Do not bump these majors casually — each is held where it is on purpose
(versions from `package.json`):

| Dependency | Pinned major | Why |
|---|---|---|
| `puppeteer-core` | `^24.43.1` | Newer majors raise the minimum Node version; 24 keeps Node 20.9 supported. |
| `vitest` (dev) | `^3.2.6` | Same reason — vitest 4 raises the Node floor above 20.9. |
| `zod` | `^3.25.76` | `@modelcontextprotocol/sdk` (`^1.29.0`) expects zod v3 schemas. Tool `inputSchema`s are zod raw shapes handed to the SDK — zod 4 breaks that contract. |

CDP protocol types come from `puppeteer-core` — there is no separate
`devtools-protocol` dependency to keep in sync.

## Setup

```bash
git clone <repo> && cd visionaire-engine
npm install
npm run build     # tsc → dist/
npm test          # 435 tests; the e2e part auto-skips without Chrome
```

## Commands

| Command | What it runs | Notes |
|---|---|---|
| `npm run build` | `tsc -p tsconfig.json` | Emits `dist/` with declarations + source maps. `dist/index.js` is the `bin` entry. |
| `npm test` | `vitest run` | All 33 test files. 60 s test/hook timeouts (browser startup headroom). |
| `npm run dev` | `tsx src/index.ts` | The MCP server from source, on stdio. It waits for an MCP client on stdin — see [Registering with MCP clients](#registering-with-mcp-clients) before wiring it up. |
| `npm run bench` | `tsx bench/run.ts` | The 24-case seeded-bug benchmark on real headless Chrome — see [Benchmark](#benchmark). |
| `npm run demo` | `tsx scripts/demo.ts` | CLI loop with no MCP client needed — see below. |

### The demo

`scripts/demo.ts` connects, takes a `page_snapshot`, then runs `explain_styles`
on one selector and prints both. Exact argument syntax:

```bash
npm run demo                                          # bundled fixture (test/fixtures/cascade.html), selector '.hero-cta .btn'
npm run demo -- <url> --selector "<css selector>"     # any live URL
npm run demo -- https://example.com --selector "h1"
npm run demo -- --help                                # usage line
```

- The first non-flag argument is the URL; `--selector <value>` and
  `--selector=<value>` both work.
- Headless is decided by TTY: piping the output (`npm run demo | less`) runs
  headless; a plain terminal opens a visible Chrome window.

Real (trimmed) output from `npm run demo`:

```
connecting (launch, headless: true) → file:///…/test/fixtures/cascade.html

=== page_snapshot ===

page: file:///…/test/fixtures/cascade.html "Cascade fixture"  viewport 1280x800
e1 body 1280x230
  e2 section.hero-cta 1280x212 @(0,0)
    e3 h1 "Build faster" 1200x37 @(40,61)
    …
    e5 a.btn "Get started" 146x42 @(40,142)
  e6 div#promo-banner "Limited offer" 1280x18 @(0,212)

=== explain_styles .hero-cta .btn ===

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
…
notes:
  - 'margin-bottom: 24px' at theme.css:10 is INACTIVE — vertical 'margin-bottom' has no effect on a non-replaced inline element; add display:block or display:inline-block
  - 'width: 100%' at theme.css:14 is INACTIVE — 'width' has no effect on a non-replaced inline element; add display:block or display:inline-block
  - winner for outline-color sits inside @layer fixture
```

This is the fastest edit-run loop for engine or formatting changes: no MCP
client, no build step (tsx runs TypeScript directly).

## Tests

Thirty-five files, 435 tests total (252 pure unit + 183 e2e):

| File | Tests | Browser? | What it covers |
|---|---|---|---|
| `test/cascade.test.ts` | 46 | no | `computeCascade` + the specificity parser, on hand-built `CSS.getMatchedStylesForNode` payloads: specificity vs order, `!important` flips, inline vs `!important`, shorthand expansion, inherited proximity, `@layer`. |
| `test/inactive.test.ts` | 16 | no | The inactive-declaration rule table (`findInactiveDeclarations`). |
| `test/wordpress.test.ts` | 40 | no | The WP detection table (`resolveWpOrigin`), origin rendering (`wpOriginToStyleOrigin`), minified-sheet degradation (`StylesheetRegistry.classify`), and page-level `detectPlatform` — all on plain metadata objects. |
| `test/animations.test.ts` | 19 | no | The closed "not smooth" ruleset R1–R6 (`engine/animations.ts`) on constructed census/computed/declaration inputs. |
| `test/e2e.test.ts` | 21 | **real headless Chrome** | Drives the ToolDefs directly (`handler(ctx, args)`, not the MCP transport) against `test/fixtures/*.html`. |
| `test/pick.e2e.test.ts` | 2 | **real headless Chrome** | `pick_element`: synthetic-click happy path and the timeout path (proves inspect mode really exits). |
| `test/listeners.e2e.test.ts` | 10 | **real headless Chrome** | `get_listeners` against `fixtures/listeners.html`: direct handlers with file:line, inline `onclick` attributes, delegation labeling, passive/once flags, ancestor/document/window walk. |
| `test/animations.e2e.test.ts` | 5 | **real headless Chrome** | `explain_animations` against `fixtures/animations.html`: the live census, declared `@keyframes`/transition attribution, and the R-findings on real computed styles. |
| `test/interaction.e2e.test.ts` | 12 | **real headless Chrome** | `record_interaction` against `fixtures/sidebar.html`, served over a local `node:http` server (LoAF script attribution is empty on `file://` pages): the cancelled-transition verdict, handler attribution, mutation/layout-shift lines, teardown. |
| `test/hardening.test.ts` | 8 | no | `sanitizePageText` (prompt-injection defense) and the `withWatchdog` fail-fast wrapper. |
| `test/hardening.e2e.test.ts` | 3 | **real headless Chrome** | Untrusted-page posture against `fixtures/hostile.html`: dialog auto-dismiss (no dead-lock), injection-shaped text neutralized in output, zero-size custom element handled. |
| `test/suggest.e2e.test.ts` | 4 | **real headless Chrome** | Near-miss selector suggestions: a guessed id/class that is not in the DOM returns the closest real names + a grounding nudge; malformed selectors report as invalid. |
| `test/blast.e2e.test.ts` | 3 | **real headless Chrome** | Blast radius + scoped fix on `fixtures/blast.html`: shared `button` rule warns it styles 2 other buttons; `#cta` suggested with a specificity verdict; silent when the winner is already unique. |
| `test/pixel.test.ts` | 12 | no | Pixel pack pure math: alignment clusters/gaps/grid/pixel-snap (`engine/alignment.ts`), WCAG color math (`engine/color.ts`), PNG decode on a handcrafted image (`engine/png.ts`). |
| `test/pixel.e2e.test.ts` | 5 | **real headless Chrome** | `check_alignment` catches a 3.5px drop + 7px gap outlier on `fixtures/pixel.html`; `pick_color` reads the painted swatch (#6c5ce7) and issues the AA/AAA verdict. |
| `test/geometry.test.ts` | — | no | Pure centering math for `measure_element` (`centeringDeltas`): centered ≈ 0, off-center signs, fix-hint wording. |
| `test/coldstart.test.ts` | — | no | Puppeteer-cache Chrome discovery (`findPuppeteerCachedChrome`) against synthetic cache layouts. |
| `test/interact.e2e.test.ts` | — | **real headless Chrome** | `interact` leaves post-action state in place: popup opens and stays inspectable; hover/focus paths. |
| `test/measure.e2e.test.ts` | — | **real headless Chrome** | `measure_element` on `fixtures/glyph.html`: off-center glyph reports a nonzero delta + shift hint; centered control ≈ 0. |
| `test/evaluate.e2e.test.ts` | — | **real headless Chrome** | `evaluate` escape hatch: expression/IIFE round-trips, promise awaiting, error surfacing, oversize truncation. |
| `test/screenshot.e2e.test.ts` | — | **real headless Chrome** | `annotated_screenshot` element crops: `clipTo`+`padding`, `scale` zoom, `annotate:false` clean mode. |
| `test/find.e2e.test.ts` | — | **real headless Chrome** | `find_elements` `match:'any'` union vs `'all'`, `visibleOnly:false` surfacing hidden elements, recovery hints. |
| `test/inject.e2e.test.ts` | 5 | **real headless Chrome** | `inject_css` live fix loop: targeted `!important` trials with computed-change reporting, page-wide rules, clean revert, mode validation.
| `test/assert.test.ts` | 45 | no | The pure assertion grammar (`engine/assert.ts`): all 17 types over constructed evidence — tolerances, DPR snapping, arity/param errors, offending-uid capping, overall verdict. |
| `test/assert.e2e.test.ts` | 16 | **real headless Chrome** | `assert_visual` against `fixtures/assert.html`: the full grammar battery with exact measured pixels (412 vs 388), suite register/re-run, per-assertion ERROR codes, pagination, the verification marker, role+name targeting, scrolled-page and deviceScaleFactor-2 runs, containing-block clip escapes, and the paint-empty-occluder filter. |
| `test/pixel-diff.test.ts` | 14 | no | The pixelmatch-port diff engine (`engine/pixel-diff.ts`) + the minimal PNG encoder (`engine/png-encode.ts`): YIQ thresholds, AA dismissal, ignore regions, grid regions, layout-diff. |
| `test/visual-diff.e2e.test.ts` | 15 | **real headless Chrome** | `visual_diff` against `fixtures/visual-diff.html`: `capture_pixels` baseline → MATCH → recolor → DIVERGENT regions attributed to the box's uid, decodable heatmap artifact, layout-diff and reference/baseline error modes, skipped dynamic masks, the verification marker, and a deviceScaleFactor-2 block (derived capture scale + emulation restore). |
| `test/impact.test.ts` | 15 | no | Pure blast-radius grouping (`engine/impact.ts`): visual_role/region/tag keys, region bucketing rule, deterministic ordering. |
| `test/impact.e2e.test.ts` | 8 | **real headless Chrome** | `impact_preview` against `fixtures/impact.html`: 23 `.nav-item` matches grouped across regions; the sandboxed dry-run counts 22 would-change and proves the `!important` element unaffected; injected style always removed. |
| `test/diagnose.e2e.test.ts` | 10 | **real headless Chrome** | `diagnose` against `fixtures/diagnose.html`: clipped/overflowing/not_centered/invisible/overlapping/wrong_size culprits with exact px evidence, the `auto` battery order, the healthy no-symptom control. |
| `test/sweep.e2e.test.ts` | 8 | **real headless Chrome** | `responsive_sweep` against `fixtures/sweep.html`: suite/assertions/diagnose payloads across viewports, FAIL cells with measured actuals, viewport restore in `finally`, payload validation. |
| `test/proof.e2e.test.ts` | 9 | **real headless Chrome** | `capture_proof` bundles: before/after phase files on disk (paths, not base64), the FAIL→PASS `verdict_delta`, missing-phase and suiteless warnings, unresolvable mark targets degrading to a warning, path-traversal rejection. |
| `test/harness-gate.test.ts` | 7 | no | The installed hook shell scripts run for real (bash + stdin JSON): the Stop gate blocks on pending-without-verified, the `stop_hook_active` loop guard, marker clearing, the nudge's pending-marker write and rendering-file filter, and the jq-missing fallback. |
| `test/verify-marker.test.ts` | 2 | no | `markVerified` default-path gating: silent no-op without a `.claude` dir, writes `.claude/.visionaire_verified` when it exists. |
| `test/harness-init.test.ts` | 9 | no | The `init-harness` installer (`src/harness-init.ts`): file installs per flag, `--force` semantics, never overwriting an existing `settings.json`, unknown-flag exit code. |


The unit tests are pure functions over constructed data — they run in
milliseconds and need no browser. The e2e files wrap everything in
`describe.skipIf(!chromePath)`, so `npm test` still passes (with the e2e files
skipped) on machines without Chrome.

Note for anything driving CDP: since v0.3 the session enables the **Debugger
domain at connect** (the ScriptRegistry listens to `Debugger.scriptParsed` for
JS file:line attribution). Enabling Debugger makes page-side `debugger;`
statements real, so `session.ts` immediately follows every enable with
`Debugger.setSkipAllPauses` — the skip flag does not survive a
disable/enable toggle (verified empirically), which is why the navigation
resync re-sets it too.

### Fixture line numbers are load-bearing

`test/e2e.test.ts` asserts *exact* file:line attributions, e.g. that
`margin-bottom: 24px` wins from `theme.css:10`. The contract is spelled out in
the comment at the top of the file. If you edit `test/fixtures/css/theme.css`
or `plugin.css`, keep that comment and the assertions in sync — inserting a
line shifts every attribution below it.

### The CDP contract smoke test

The last `describe` block in `test/e2e.test.ts` (the "CDP contract smoke"
block) exists so a Chrome update that breaks our protocol assumptions
fails loudly instead of producing silently wrong verdicts. It asserts, on real
Chrome:

- `CSS.getMatchedStylesForNode` returns `matchedCSSRules` with
  `matchingSelectors`, `selectorList.selectors[].text`, and
  `style.cssProperties` — the raw material of the cascade engine;
- per-declaration `range` + `rule.styleSheetId` are present (the 3-hop
  declaration → sheet → file:line join depends on them), and the
  0-based CDP line matches the fixture's known 1-based line;
- `inlineStyle` is populated for an element with a `style=""` attribute.

Two *experimental* fields — `selector.specificity` and `rule.layers` — are
logged as present/absent but never fail the test, because the engine
feature-detects them and falls back to its own parser. Note: this contract
check lives inside `test/e2e.test.ts` rather than a standalone
`test/cdp-contract.test.ts`.

### Running a subset

```bash
npx vitest run test/inactive.test.ts        # one file
npx vitest run -t "letter-spacing"          # by test name
```

## Benchmark

`bench/` is the seeded-bug benchmark harness — the regression
suite for *explanation quality*, separate from `npm test`. Each fixture page
under `bench/cases/` seeds exactly **one** known visual bug a real developer
would report ("the subscribe button has too much space under it").
`bench/manifest.json` records, per case: the user-phrased symptom, the target
element, which tool should reveal the cause (`explain_styles` |
`inspect_element` | `inspect_ancestors` | `get_listeners` |
`explain_animations` | `record_interaction`), the tool args, and the `expected`
substrings that must ALL appear in the tool output for a pass. Markers are
chosen to prove the engine named the **true cause** — the winning `file:line`,
`lost (specificity)`, `occluded by`, `[BINDING]`, `CANCELLED` — never
incidental strings or full formatted lines (those are cosmetic and may be
reworded).

```bash
npm run bench             # all 24 cases (~5 s on real headless Chrome)
npx tsx bench/run.ts      # the same, without the npm script
npx tsx bench/run.ts 11   # a single case by manifest id
```

The runner launches one headless `SessionManager`, navigates to each fixture,
and drives the named ToolDef handler directly (`handler(ctx, args)`, like the
e2e suite). Fixtures load from `file://` by default; a case with
`"serve": "http"` in the manifest is served from a local `node:http` static
server instead — the v0.3 time-dimension cases need a real origin, because
LoAF script attribution is empty on `file://` pages. The runner
prints a per-case table — id, status, tool-output tokens, and the tokens of
one `page_snapshot` per case (the census an agent would realistically spend to
find the element), reported separately — then a summary line: `N/24 pass,
median context tokens X`. Failed cases print their missing markers plus the
full tool output. Exit code 1 on any FAIL, so it is CI-usable.

### Adding a case

1. Create `bench/cases/caseNN-<slug>.html` with its CSS under
   `bench/cases/css/` and any JS under `bench/cases/js/`. WordPress-flavored
   cases put sheets under `bench/cases/wp-content/{themes,plugins}/…` so the
   URL-convention resolver fires. Behavioral cases that rely on
   script attribution should set `"serve": "http"` in their manifest entry.
   Seed exactly one bug and state it in a comment at the top of the page.
2. Culprit-rule **line numbers are load-bearing**, same convention as
   `test/fixtures/css/`: comment-pad the CSS so the rule sits at the line the
   manifest asserts, and document that line in the file's header comment.
3. Append a manifest entry: `{ id, file, user_report, target, tool, args,
   expected }`. `user_report` is one sentence phrased as a user would describe
   the symptom, not the diagnosis.
4. Run `npx tsx bench/run.ts <id>` until green — without weakening the markers
   below what proves causation.

### The XFAIL convention

When the engine genuinely cannot name a cause yet, do **not** weaken a case to
make it pass. Keep the ideal cause-proving markers and mark the manifest entry
`"expected_fail": true` with a `"reason"` naming the missing engine capability.
The runner reports such cases as XFAIL, not FAIL, and they do not affect the
exit code. If the engine later learns to name the cause, the case flips to
XPASS and the runner exits 1 with `XPASS: tighten the manifest` — remove
`expected_fail` and firm up the markers. The lifecycle poster child is case 9
(the implicit `min-width:auto` of flex items): XFAIL through v0.2, flipped by
the v0.3 flex diagnostic in `engine/ancestors.ts`, markers then tightened to
the full diagnostic phrase plus `[BINDING]`.

## Project layout

```
src/
  index.ts          # bin entry: stdio transport, graceful shutdown
  server.ts         # createServer(session) — registers all 28 tools; owns connect/navigate/set_viewport
  session.ts        # SessionManager (launch/attach Chrome, CDP domains incl. Debugger); findChromeExecutable()
  types.ts          # every shared contract, incl. ToolDef and COMPUTED_WHITELIST
  uid.ts            # UidRegistry + resolveTarget (uid | selector | x,y → node)
  tools/            # the ToolDefs, one file each (page-snapshot, explain-styles, assert-visual, …)
  engine/           # pure deterministic engines: cascade, specificity, inactive, visibility, stacking, box-model, ancestors, animations
  attribution/      # stylesheets registry, scripts registry, sourcemaps, wordpress resolver
  format/           # census + dossier renderers (token-budgeted plain text)
  store/            # v0.7 persistence: artifacts dir, assertion suites, pixel baselines, proof bundles, the verification marker
  harness-init.ts   # the `npx visionaire-engine init-harness` installer
harness/            # verify-after-edit harness sources it installs: Claude Code skill + hooks, Cursor rule (docs/harness.md)
scripts/demo.ts     # the CLI demo
test/               # unit + e2e + fixtures (see above)
```

The v0.7 verification layer adds `src/store/` (suite/baseline/bundle/marker
persistence with path-traversal-safe ids), the pure engines
`engine/assert.ts` / `assert-collect.ts` / `pixel-diff.ts` / `png-encode.ts` /
`impact.ts` / `diagnose.ts`, and `harness/` — the Claude Code hooks and Cursor
rule installed into a project by `npx visionaire-engine init-harness`
(`src/harness-init.ts`).

Full data-flow walkthrough: [architecture.md](architecture.md).

Conventions: ESM + NodeNext — **relative imports must use the `.js`
extension** even in `.ts` files; strict TypeScript; no default exports; token
estimate is `Math.ceil(chars / 4)` (`estimateTokens` in `src/types.ts`).

## Extending

### Recipe 1: add a new MCP tool

Every tool module exports one `ToolDef` (from `src/types.ts`):

```ts
export interface ToolDef {
  name: string
  description: string
  inputSchema: ZodRawShape   // the raw object you would pass to z.object(...)
  handler: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>
}
```

`ToolContext` gives you `{ page, cdp, uids, sheets, scripts? }` — the puppeteer
`Page`, a CDP session, the uid registry, the stylesheet registry, and (wired at
connect since v0.3) the script registry for JS file:line attribution.
`ToolResult` is `{ text, images? }`. The older tools render plain-text dossiers;
the six v0.7 verification tools instead return a compact JSON envelope in `text`
(`{verdict?, summary, …, truncated, next_offset?, artifacts?}`, images as file
paths under the artifacts dir) — follow that convention for new
verification-style tools (`src/tools/assert-visual.ts` is the reference).

1. **Create `src/tools/my-tool.ts`** following the existing pattern
   (`src/tools/node-at-point.ts` is the shortest real example):

   ```ts
   import { z } from 'zod'
   import type { ToolContext, ToolDef } from '../types.js'

   const inputSchema = {
     uid: z.string().optional().describe('Element uid from a prior page_snapshot'),
   }
   const argsSchema = z.object(inputSchema)

   export const myToolTool: ToolDef = {
     name: 'my_tool',
     description: 'One sentence of what it returns. One "Use when…" sentence.',
     inputSchema,
     handler: async (ctx, args) => {
       const a = argsSchema.parse(args)
       // … CDP calls via ctx.cdp.send(...), uids via ctx.uids.assign(...)
       return { text: '…' }
     },
   }
   ```

   Note `inputSchema` is the **raw shape**, not `z.object(...)` — the MCP SDK
   wraps it itself. Validate inside the handler with your own
   `z.object(inputSchema).parse(args)` if you want parsed types.

2. **Register it in `src/server.ts`**: import the ToolDef and append it to the
   `toolDefs` array in `createServer`. `registerToolDef` wires the handler,
   catches thrown errors, and turns them into `isError` results — so inside a
   handler, just `throw new Error('actionable message')`.

3. **Description conventions**: `server.ts` has a `DESCRIPTIONS` map of
   "when-to-use" descriptions surfaced to the calling LLM, keyed by tool name;
   it **overrides** the ToolDef's own `description` when an entry exists. Add
   an entry there for a first-party tool, or rely on the ToolDef description.
   Follow the house style: what it returns, then an explicit "Use this to…"
   sentence, and mention how the tool interacts with uids if it does.

4. Target elements the standard way: accept `uid` / `selector` / `x`+`y` and
   pass them to `resolveTarget(ctx, args)` from `src/uid.ts` (see
   `explain-styles.ts`).

5. **Never `console.log` in tool or server code** — see
   [Debugging tips](#debugging-tips).

The three session tools (`connect`, `navigate`, `set_viewport`) are *not*
ToolDefs; they are registered directly in `server.ts` because they own the
`SessionManager` lifecycle.

### Recipe 2: add an inactive-declaration rule

Rules live in the `RULES` table in `src/engine/inactive.ts` — "you set it, but
it does nothing because…" findings, in the spirit of Firefox's inactive-css.
One table entry per rule:

```ts
interface InactiveRule {
  match: (decl: DeclarationInfo, ctx: RuleCtx) => boolean
  reason: (decl: DeclarationInfo, ctx: RuleCtx) => string
  fixHint: (decl: DeclarationInfo, ctx: RuleCtx) => string | undefined
}
```

`RuleCtx` gives you `display`, `position`, `parentDisplay`, `parentIsFlex`,
`parentIsGrid`, and the full `computed` map of the element. A real entry from
the table:

```ts
{
  // z-index DOES apply to static flex/grid items, so those are excluded.
  match: (d, ctx) =>
    d.property === 'z-index' &&
    d.value.trim() !== 'auto' &&
    ctx.position === 'static' &&
    !ctx.parentIsFlex &&
    !ctx.parentIsGrid,
  reason: () =>
    `'z-index' has no effect on a position:static element that is not a flex or grid item`,
  fixHint: () => 'add position:relative (or absolute/fixed/sticky)',
},
```

Rules are checked in table order and the **first match wins** per declaration
(the loop `break`s), so put narrower rules before broader ones. The function is
pure — no browser, no CDP.

Add a case to `test/inactive.test.ts` using its `decl(property, value)` and
`cm({ display: '…' })` helpers:

```ts
it('flags my new case', () => {
  const findings = findInactiveDeclarations([decl('my-prop', 'value')], cm({ display: 'block' }))
  expect(findings).toHaveLength(1)
  expect(findings[0]!.reason).toContain('…')
})
```

Keep in mind who calls it: `explain_styles` runs the table over *winning,
authored, non-inherited* declarations only, and feeds `parentDisplay` from CDP
(with a JS fallback) — see `src/tools/explain-styles.ts`.

### Recipe 3: add a WordPress detection pattern

`src/attribution/wordpress.ts` is pure (no browser) and has two tables:

**`DETECTION_TABLE`** — an ordered list of `(meta: WpSheetMeta) => WpOrigin |
undefined` rules; the first hit wins. **Order is load-bearing**: exact owner-id
rules (e.g. `global-styles-inline-css`) must run before the generic
`{handle}-inline-css` suffix rule, and generated-URL rules before the
theme/plugin URL rules. A real entry:

```ts
(m) => (ELEMENTOR_GLOBAL_CSS.test(m.sourceURL) ? { kind: 'elementor-global' } : undefined),
```

`WpSheetMeta` gives you `sourceURL`, `ownerNodeAttrId` (the `id=""` of the
owning `<style>`/`<link>` — where WP handles live), `isInline`, and optionally
a `selector` from the rule being attributed (used to extract
`.elementor-element-{id}` widget ids).

**`KIND_TABLE`** — maps each `WpOriginKind` to the rendered `StyleOrigin`:
a granularity from the honesty ladder (`line > file > db-entity > component >
generated > unknown`), a human `label`, and an actionable `editSurface`. Be
honest here: a generated file that exists on disk but is not the thing to edit
gets `granularity: 'generated'` and an editSurface pointing at the real control
(see the `elementor-post` and `divi-generated` entries). Note: the
rule-level `child-theme` and `unknown` kinds were removed in v0.2 —
parent/child theme detection is page-level only (`detectPlatform`), and
sheets no rule matches fall through to the generic classifier instead of a
catch-all kind.

Steps for a new pattern:

1. If it is a new *kind*, add it to the `WpOriginKind` union in `src/types.ts`
   and add a `KIND_TABLE` entry. If it matches an existing kind (e.g. a new
   optimizer), extend the existing structures — optimizers go in
   `OPTIMIZER_BUNDLES` with a `bypassHint` query param.
2. Add the detection rule to `DETECTION_TABLE` at the right position.
3. If it should show up in `page_origins` platform output (a new builder or
   optimizer), also extend `detectPlatform()` at the bottom of the file.
4. Add cases to `test/wordpress.test.ts` using its `meta()` helper:

   ```ts
   it('my-cache URL → optimizer-bundle with bypass hint', () => {
     const wp = resolveWpOrigin(meta({ sourceURL: `${SITE}/wp-content/cache/my-cache/bundle.css` }))
     expect(wp?.kind).toBe('optimizer-bundle')
     expect(wp?.bypassHint).toBe('?my-bypass')
   })
   ```

   Include at least one *ordering* test if your rule could shadow (or be
   shadowed by) a neighbor — that is what most of the existing 32 tests guard.

### Recipe 4: add a computed property to the whitelist

`COMPUTED_WHITELIST` in `src/types.ts` is the closed list of layout-affecting
computed properties (57 entries: display, position, box metrics, flex/grid,
typography basics, …). It is consumed in three places:

- **`page_snapshot`** — passed as the `computedStyles` filter to
  `DOMSnapshot.captureSnapshot`; the snapshot's layout hints and visibility
  reasons can only see whitelisted properties.
- **`inspect_element`** — the "what" dossier iterates the whitelist to build
  its computed → used pairs.
- **`style_diff`** — records and compares exactly the whitelisted properties;
  a change in a non-whitelisted property is invisible to a diff.

To add one, append it to the array — nothing else to register. Costs to weigh:
every whitelisted property is captured **per node** in page snapshots, so each
addition adds capture work and potential dossier tokens across all three tools.
The list exists to keep dossiers in their 300–800 token budget.

## Registering with MCP clients

For copy-paste configs for every popular client — Claude Code, Claude Desktop,
Cursor, GitHub Copilot (VS Code **and** CLI), and Google Antigravity — see the
dedicated **[client setup guide](clients.md)**. The essentials for local hacking:

Build first (`npm run build`), then, for Claude Code:

```bash
claude mcp add visionaire -- node /absolute/path/to/visionaire-engine/dist/index.js
```

Any other stdio client uses `command: "node"` + `args: ["…/dist/index.js"]` under
its own top-level key (`mcpServers` for most; **`servers`** for VS Code Copilot).

**Gotcha: Claude Code and the Claude desktop app read different configs.**
On one machine there are two independent MCP registries, and registering in
one does not make the server appear in the other:

| Config file | Read by | UI that shows it |
|---|---|---|
| `~/.claude.json` (`mcpServers` key) | Claude Code sessions (CLI and desktop app) | `claude mcp list` |
| `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) | The Claude app's own server manager | Settings → "Local MCP servers" panel |

`claude mcp add` writes only the first. If you expect the server in the
Settings panel, add the same stdio JSON entry to the second file (Edit Config
button) and **fully restart the app** — the panel reads its config at launch.
Either registration alone is enough for the server to actually work in its
respective client; you only need both if you use both.

**During development**, run from source without rebuilding:

```bash
claude mcp add visionaire-dev -- npx tsx /absolute/path/to/visionaire-engine/src/index.ts
```

Do **not** register `npm run dev` as the server command: npm prints its
`> visionaire-engine@0.1.0 dev` banner to **stdout**, which corrupts the MCP
protocol stream before the server even starts. Invoke `node dist/index.js` or
`npx tsx src/index.ts` directly.

## Debugging tips

- **`npm run demo` is the fastest loop.** It exercises the same
  `SessionManager` and ToolDef handlers as the MCP server, prints to a normal
  terminal, and runs TypeScript directly via tsx — no client, no build.
- **stdio servers must never write to stdout.** `dist/index.js` speaks the MCP
  protocol on stdout; one stray `console.log` in server, session, tool, engine,
  attribution, or format code breaks every client. Use `console.error` for
  diagnostics (see `src/index.ts` — even the startup banner goes to stderr).
  `scripts/demo.ts` is the only place `console.log` is fine.
- **`CHROME_PATH`** overrides browser discovery — point it at any
  Chrome/Chromium binary. Useful when only a non-standard install exists (the
  e2e suite un-skips itself once `findChromeExecutable()` succeeds).
- **Attach instead of launch** to debug against your real, logged-in browser:
  start Chrome with `--remote-debugging-port=9222`, then
  `connect { browserUrl: "http://127.0.0.1:9222" }`. Launched browsers are
  killed on disconnect; attached ones are left alone.
- **uids are per-document.** After any navigation, previous `e*` uids are
  stale; the `navigate` tool says so in its response, and `session.ts` resyncs
  the stylesheet registry with an awaited `CSS.disable`/`CSS.enable` toggle.
  If an attribution comes back empty right after a navigation you triggered
  some other way (JS redirect, form submit), take a fresh `page_snapshot`.
- **Inspect the raw protocol** with the MCP Inspector:
  `npx @modelcontextprotocol/inspector node dist/index.js`.
- **Chrome update broke something?** Run
  `npx vitest run test/e2e.test.ts -t "CDP contract"` first — if the contract
  smoke test fails or logs an experimental field as ABSENT, the problem is
  upstream protocol shape, not your change.

## Roadmap

Summarized from [architecture.md](architecture.md):

- **v0.1 (shipped):** the first 12 tools, Chromium launch/attach,
  WordPress convention mode (zero WP cooperation).
- **v0.2 (shipped):** `pick_element` click-to-pick (the 13th
  tool, via `Overlay.setInspectMode`); the deterministic seeded-bug benchmark
  harness (`bench/`, run with `npm run bench`); minification-aware granularity
  degradation; census platform header.
- **v0.3 (this codebase — the time dimension):** `get_listeners`,
  `explain_animations`, `record_interaction`; the ScriptRegistry (JS file:line
  attribution through the WP origin lens); the flex `min-width:auto`
  diagnostic (flipped bench case 9 from XFAIL to PASS).
- **v0.4:** trace-based compositor-failure reasons (Lighthouse's
  non-composited-animations enum decode); opt-in DOM-breakpoint attribution
  for attribute mutations; source-map hardening; `@layer` verdict edge cases;
  `style_diff` across viewports.
- **v1.1:** a WordPress companion plugin (~6 Abilities on the official
  mcp-adapter, WP 6.9+) for enqueue-registry lookups, Elementor control
  resolution, and template-override detection.
- **v1.2:** the LLM-in-the-loop half of the benchmark (does the context lift
  model diagnosis accuracy and cut token cost); Firefox/BiDi investigation.
