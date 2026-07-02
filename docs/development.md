# Development guide

Building, testing, and extending visionaire-engine. For what the tools do, see
[tools.md](tools.md); for how the pipeline works internally, see
[architecture.md](architecture.md); the authoritative design doc is
[../SPEC.md](../SPEC.md).

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

CDP protocol types come from `puppeteer-core` (SPEC §10) — there is no separate
`devtools-protocol` dependency to keep in sync.

## Setup

```bash
git clone <repo> && cd visionaire-engine
npm install
npm run build     # tsc → dist/
npm test          # 112 tests; e2e part auto-skips without Chrome
```

## Commands

| Command | What it runs | Notes |
|---|---|---|
| `npm run build` | `tsc -p tsconfig.json` | Emits `dist/` with declarations + source maps. `dist/index.js` is the `bin` entry. |
| `npm test` | `vitest run` | All 4 test files. 60 s test/hook timeouts (browser startup headroom). |
| `npm run dev` | `tsx src/index.ts` | The MCP server from source, on stdio. It waits for an MCP client on stdin — see [Registering with MCP clients](#registering-with-mcp-clients) before wiring it up. |
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

Four files, 112 tests total (94 pure unit + 18 e2e):

| File | Tests | Browser? | What it covers |
|---|---|---|---|
| `test/cascade.test.ts` | 46 | no | `computeCascade` + the specificity parser, on hand-built `CSS.getMatchedStylesForNode` payloads: specificity vs order, `!important` flips, inline vs `!important`, shorthand expansion, inherited proximity, `@layer`. |
| `test/inactive.test.ts` | 16 | no | The inactive-declaration rule table (`findInactiveDeclarations`). |
| `test/wordpress.test.ts` | 32 | no | The WP detection table (`resolveWpOrigin`), origin rendering (`wpOriginToStyleOrigin`), and page-level `detectPlatform` — all on plain metadata objects. |
| `test/e2e.test.ts` | 18 | **real headless Chrome** | Drives the ToolDefs directly (`handler(ctx, args)`, not the MCP transport) against `test/fixtures/*.html`. |

The unit tests are pure functions over constructed data — they run in
milliseconds and need no browser. The e2e file wraps everything in
`describe.skipIf(!chromePath)`, so `npm test` still passes (with the e2e file
skipped) on machines without Chrome.

### Fixture line numbers are load-bearing

`test/e2e.test.ts` asserts *exact* file:line attributions, e.g. that
`margin-bottom: 24px` wins from `theme.css:10`. The contract is spelled out in
the comment at the top of the file. If you edit `test/fixtures/css/theme.css`
or `plugin.css`, keep that comment and the assertions in sync — inserting a
line shifts every attribution below it.

### The CDP contract smoke test

The last `describe` block in `test/e2e.test.ts` ("CDP contract smoke
(SPEC §10)") exists so a Chrome update that breaks our protocol assumptions
fails loudly instead of producing silently wrong verdicts. It asserts, on real
Chrome:

- `CSS.getMatchedStylesForNode` returns `matchedCSSRules` with
  `matchingSelectors`, `selectorList.selectors[].text`, and
  `style.cssProperties` — the raw material of the cascade engine;
- per-declaration `range` + `rule.styleSheetId` are present (the 3-hop
  declaration → sheet → file:line join in SPEC §7.2 depends on them), and the
  0-based CDP line matches the fixture's known 1-based line;
- `inlineStyle` is populated for an element with a `style=""` attribute.

Two *experimental* fields — `selector.specificity` and `rule.layers` — are
logged as present/absent but never fail the test, because the engine
feature-detects them and falls back to its own parser (SPEC §9). Note: SPEC §10
names this test `test/cdp-contract.test.ts`; in the code it lives inside
`test/e2e.test.ts`.

### Running a subset

```bash
npx vitest run test/inactive.test.ts        # one file
npx vitest run -t "letter-spacing"          # by test name
```

## Project layout

```
src/
  index.ts          # bin entry: stdio transport, graceful shutdown
  server.ts         # createServer(session) — registers all 12 tools; owns connect/navigate/set_viewport
  session.ts        # SessionManager (launch/attach Chrome, CDP domains); findChromeExecutable()
  types.ts          # every shared contract, incl. ToolDef and COMPUTED_WHITELIST
  uid.ts            # UidRegistry + resolveTarget (uid | selector | x,y → node)
  tools/            # nine ToolDefs, one file each (page-snapshot, explain-styles, …)
  engine/           # pure deterministic engines: cascade, specificity, inactive, visibility, stacking, box-model, ancestors
  attribution/      # stylesheets registry, sourcemaps, wordpress resolver
  format/           # census + dossier renderers (token-budgeted plain text)
scripts/demo.ts     # the CLI demo
test/               # unit + e2e + fixtures (see above)
```

Full data-flow walkthrough: [architecture.md](architecture.md).

Conventions (SPEC §11): ESM + NodeNext — **relative imports must use the `.js`
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

`ToolContext` gives you `{ page, cdp, uids, sheets }` — the puppeteer `Page`,
a CDP session, the uid registry, and the stylesheet registry. `ToolResult` is
`{ text, images? }`.

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
(see the `elementor-post` and `divi-generated` entries).

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
The list exists to keep dossiers in their 300–800 token budget (SPEC §3, §5).

## Registering with MCP clients

Build first (`npm run build`), then:

**Claude Code**

```bash
claude mcp add visionaire -- node /absolute/path/to/visionaire-engine/dist/index.js
```

**Generic stdio config** (Claude Desktop, Cursor, and most other clients):

```json
{
  "mcpServers": {
    "visionaire": {
      "command": "node",
      "args": ["/absolute/path/to/visionaire-engine/dist/index.js"]
    }
  }
}
```

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

Summarized from [../SPEC.md](../SPEC.md) §13:

- **v0.1 (shipped, this codebase):** the 12 tools, Chromium launch/attach,
  WordPress convention mode (zero WP cooperation).
- **v0.2:** source-map hardening, deeper stacking/z-index explanations,
  `@layer` verdict edge cases, `style_diff` across viewports.
- **v1.1:** CDP-injected click-to-pick overlay (`Overlay.setInspectMode`);
  a WordPress companion plugin (~6 Abilities on the official mcp-adapter,
  WP 6.9+) for enqueue-registry lookups, Elementor control resolution, and
  template-override detection.
- **v1.2:** a seeded-bug benchmark (20–30 visual bugs, measuring LLM diagnosis
  accuracy and token cost with vs without the server); Firefox/BiDi
  investigation.
