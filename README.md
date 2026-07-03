# Visionaire Engine

> **Which rule, which file, which line — and why it wins.**

![Visionaire Engine hero image](hero.png)

![Endless re-prompting vs one pinpointed fix — the problem Visionaire solves](hero-2.jpeg)

An MCP server that gives LLMs deterministic "rendering truth" about live web pages, so they can debug CSS, design, and WordPress issues instead of guessing from screenshots.

**Status: v0.6.** 22 tools, 276 tests (163 unit + 113 end-to-end on real Chrome) plus a 24-case seeded-bug benchmark (`npm run bench`), verified live against wordpress.org. New in v0.6 — the pixel-perfect pack: `check_alignment` (group alignment/gap-rhythm/grid/pixel-snap audit) and `pick_color` (actual painted-pixel sampling + WCAG contrast verdicts). v0.5: `inject_css` — the live fix loop (trial a fix on the page, see what changed, converge, write source once) — `navigate { bypassCache }` for stale-stylesheet hard reloads, and blast-radius + scoped-fix reporting on `explain_styles` (change THE button, not all buttons). v0.4 (field-report items): `interact` to drive the UI into a state and inspect it, `measure_element` for sub-pixel glyph/text-ink centering, and an `evaluate` escape hatch — plus element-scoped crops/zoom on `annotated_screenshot`, `match:"any"`/`visibleOnly:false` on `find_elements`, and zero-config cold-start Chrome discovery. v0.3 added the time dimension — event-listener attribution, animation diagnosis, and source-attributed interaction timelines. Hardened for untrusted pages (prompt-injection sanitization, fail-fast watchdog, dialog auto-dismiss).

## The problem

When you see a visual bug and ask an LLM to fix it, the LLM gets either pixels (no code linkage) or code (no rendering truth). Existing browser MCPs ship accessibility snapshots that deliberately strip all styling. The missing layer is **explanation and attribution**:

- *Which* CSS rule wins the cascade for this property, and why did the others lose?
- *Which file, which line* does the winner live in — or which Elementor widget control, or which Customizer entry?
- *Why* is this element invisible / misaligned / the wrong size?

Visionaire Engine answers those questions with zero AI inside: everything is computed deterministically from the Chrome DevTools Protocol plus closed rulesets. The fuzzy work (matching "the button under the hero looks off" to an element) stays with the calling LLM, which gets uid-keyed snapshots, search tools, and annotated screenshots to do it cheaply.

## What the output looks like

Live against wordpress.org:

```
why color = rgb(255, 255, 255):
  WINNER  [class*=wp-block] .wp-block-button__link { color: var(--wp--custom--button--color--text) }  spec(0,2,0)
    → themes/wporg-parent-2021/build/style.css:499  [line | theme: wporg-parent-2021 — edit themes/wporg-parent-2021/build/style.css]
  lost (specificity)  :root :where(.wp-element-button, .wp-block-button__link) { color: #fff }  spec(0,1,0)
    → global-styles-inline-css:2  [db-entity | Global Styles — Site Editor → Styles (theme.json / wp_global_styles)]
  lost (origin)  a:-webkit-any-link { color: -webkit-link }  spec(0,1,1)
    → user-agent stylesheet
```

Winner, losers with the decisive loss reason, and an honest edit pointer for each — including WordPress-aware answers like "Site Editor → Styles" instead of a useless path to a generated file.

## Quick start

Requires Node ≥ 20 and Chrome/Chromium installed.

```bash
npm install && npm run build

# register with Claude Code:
claude mcp add visionaire -- node /absolute/path/to/visionaire-engine/dist/index.js
```

Using **GitHub Copilot, Cursor, Claude Desktop, Google Antigravity**, or another
client? See **[docs/clients.md](docs/clients.md)** for a copy-paste config for each,
plus browser-install help for Linux/WSL/Docker.

**Run it from your project's root directory** — visionaire is at its best when the
agent has both the running site *and* its source on disk, so it can cross-reference
the two. Ground before you search: take a `page_snapshot` (or read the source) to
get real element names instead of guessing selectors. If a selector matches
nothing, the error suggests the closest real ids/classes on the page.

Then in a session:

1. `connect { url: "https://your-site.com" }` — launches Chrome (or `{ browserUrl: "http://127.0.0.1:9222" }` to attach to your real logged-in browser)
2. `page_snapshot {}` — uid-keyed census of what's visible; **target elements by their `uid`**, not invented selectors
3. `explain_styles { uid: "e17", property: "margin-bottom" }` — cascade verdict with file:line

Try it without an MCP client:

```bash
npm run demo                                              # bundled fixture
npm run demo -- https://wordpress.org --selector "a.wp-block-button__link"
```

## The 22 tools

| Tool | Purpose |
|---|---|
| `connect` / `navigate` / `set_viewport` | Session: launch or attach to Chrome, go to a URL (`bypassCache` for hard reloads), emulate viewports |
| `page_snapshot` | Pruned, uid-keyed tree of what's visible — geometry, layout hints, invisibility reasons |
| `page_origins` | Stylesheet inventory + platform detection (WordPress version, theme, builders, optimizers) |
| `inspect_element` | The "what": box model, computed values, visibility verdict |
| `explain_styles` | **The wedge**: cascade winner/loser per property with file:line + origin attribution, each winner's **blast radius** (how many other elements it styles), and a scoped-fix selector for just this element |
| `inspect_ancestors` | Constraint-chain walk: which ancestor constrains width/overflow/stacking |
| `find_elements` | Deterministic search by text, selector, role, or screen region — AND-combined by default, `match:"any"` for a union, `visibleOnly:false` to include hidden elements |
| `node_at_point` | x,y → element uid + ancestor chain |
| `pick_element` | Human-in-the-loop grounding: DevTools-style hover highlight, the user clicks the element that looks wrong |
| `get_listeners` | Event listeners on an element + its ancestors, with handler file:line and capture/passive/once flags |
| `explain_animations` | Animations/transitions touching an element: live census, declared rules with file:line, and a closed "why is it not smooth" ruleset |
| `record_interaction` | One interaction → a source-attributed causal timeline: handlers, mutations, cancelled transitions, layout shifts |
| `interact` | Drive the UI into a state (open a menu/popup/modal, reveal a tab) and **leave it there** so you can inspect the new state — reports post-action visibility + box |
| `measure_element` | Sub-pixel rendered geometry: content box + true text-ink box (glyph extents) with a centering verdict — "is this × actually centered?" |
| `check_alignment` | Group pixel audit: which of N elements is off-alignment by how many px, gap-rhythm outliers, size consistency, N-px grid conformance, pixel-snap warnings |
| `pick_color` | The actual painted pixel (composited truth: gradients, images, opacity) + computed colors + WCAG AA/AAA contrast verdict |
| `evaluate` | Escape hatch: run agent-authored JavaScript in the page and get the JSON result, for the genuinely bespoke case no other tool covers |
| `inject_css` | The live fix loop: trial declarations on an element (or a page-wide rule) without touching source — see what changed, converge, write source once, revert |
| `annotated_screenshot` | Screenshot with numbered marks that equal snapshot uids — or an element-scoped crop via `clipTo` with `padding`/`scale` zoom and optional `annotate:false` |
| `style_diff` | Record styles, compare later — verify-my-fix loops |

Full reference: [docs/tools.md](docs/tools.md)

## Documentation

- [docs/clients.md](docs/clients.md) — install in Claude, Copilot, Cursor, Antigravity, and other MCP clients
- [docs/tools.md](docs/tools.md) — tool-by-tool reference with real examples
- [docs/architecture.md](docs/architecture.md) — how the deterministic pipeline works
- [docs/wordpress.md](docs/wordpress.md) — WordPress origin resolution guide
- [docs/development.md](docs/development.md) — building, testing, extending

## Design principles

1. **No internal LLM** — deterministic, cacheable, testable, host-agnostic.
2. **Fuzzy grounding belongs to the calling LLM**; we make it cheap.
3. **Complement the incumbent browser MCPs** (same uid idiom), don't compete.
4. **Honesty ladder** on every attribution: `line > file > db-entity > component > generated > unknown`.
5. **Token-budgeted output** — a dossier is 300–800 tokens, never a dump.

## Security posture

Visionaire is pointed at arbitrary, untrusted pages, so it treats page content as hostile:

- **Prompt-injection defense.** Page-derived strings (element text, class names, ids, attribute values) are sanitized at the single choke point where they enter tool output — collapsed to one line, stripped of control and bidirectional-override characters, and length-capped. A page cannot smuggle instruction-shaped text formatted as a "system message" toward the calling LLM; such content can only appear as an inert, quoted, truncated fragment.
- **Fail-fast, never hang.** Every tool call is wrapped in a watchdog (default 60s, `VISIONAIRE_TOOL_TIMEOUT_MS` to override; `pick_element`/`record_interaction` get their declared wait plus slack). A wedged browser returns an actionable error telling you to `connect` again, instead of blocking the client.
- **No dead-locking dialogs.** Page `alert()`/`confirm()`/`prompt()` calls are auto-dismissed — otherwise they would block every evaluate-family CDP call indefinitely.

Visionaire never executes page-authored code as instructions; it only reads and attributes. The calling LLM should still treat tool output as data about a page, not as commands.

## Known limitations

- Chromium-only (CDP is the only path to matched-rule source locations; `getMatchedCSSRules` was removed from browsers years ago).
- `@layer`: unlayered-vs-layered ordering is exact; ordering between two *different* layer chains is a deterministic proxy (CDP doesn't expose layer declaration order).
- Some CDP fields we rely on (`specificity`, `layers`) are experimental; the engine feature-detects them and falls back (e.g. to its own specificity parser), and a contract smoke test in `test/e2e.test.ts` fails loudly if a Chrome update breaks the core protocol shape (the experimental fields are logged as present/absent).

## License

**Dual-licensed — free for people, paid for companies:**

- **Noncommercial use** (individuals, personal projects, hobby/study, charities, educational and public research institutions): free under the [PolyForm Noncommercial License 1.0.0](LICENSE).
- **Commercial use** (use by or for a business, in paid work, or in any product or service): requires a commercial license. Contact [@mi60dev](https://github.com/mi60dev) (GitHub issue or profile) to obtain one.

Contributions are welcome, but note that by contributing you agree your contribution is licensed to the project owner under terms compatible with this dual-licensing model.

*Versions prior to v0.6.1 were published under MIT; that grant applies only to those historical versions.*
