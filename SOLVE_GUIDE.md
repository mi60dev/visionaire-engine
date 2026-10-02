# `solve` — the gateway

Visionaire registers four MCP tools: `connect`, `navigate`, `set_viewport` and **`solve`**. `solve` is how an agent reaches every diagnostic in the engine.

## Three ways to call it

```jsonc
// 1. Describe the problem — solve routes it
{ "intent": "why is the header CTA blue instead of white", "context": { "element": ".site-header .cta" } }

// 2. Force a plan (skip routing)
{ "intent": "tooltip under the hero", "scenario": "overlap-z-index", "context": { "element": "e42" } }

// 3. Expert mode — one engine tool, args validated against its schema
{ "intent": "trial fix", "tool": "inject_css", "args": { "uid": "e42", "declarations": { "z-index": "20" } } }
```

`context` keys: `element` (uid `e12`/`f12`, CSS selector, or visible text like `"Subscribe button"`), `property`, `viewport {width,height}`, `elements` (selector for a group), `reference_element`, `breakpoints`.

## What comes back

```
solve → spacing-wrong: Spacing — margin / padding / gap winners
target: e7 — found by text "Get started link"

── explain_styles ──
margin-bottom = 24px  WINNER .hero-cta .btn → css/theme.css:10 … lost .btn → css/plugin.css:5 (specificity)
── measure_element ──
…

NEXT: collapsing margins and parent padding are common — run with property "padding" on the parent uid …
(steps: explain_styles ✓, measure_element ✓ · session: launch)
```

- The **route** is always echoed; when another scenario also matched, it says so and how to force it.
- When the element is missing, solve answers `NEED:` plus a uid outline of the page — pick a uid and call again.
- When nothing matches, it lists the closest scenarios instead of guessing.
- Answers are capped at ~4k tokens; trimmed sections name the expert-mode call that returns them in full.

## Routing (deterministic, offline)

`src/keyword-router.ts` scores each scenario by weighted regex cues from `src/scenarios.ts` (no model, no network). A scenario runs when it scores ≥ 3; the CSS property is inferred from the sentence (`padding-top: 40px`, "background", "z-index") unless `context.property` is given.

| Scenario | Plan |
|---|---|
| `color-wrong` | explain_styles(color) + pick_color |
| `style-not-apply`, `what-rule-sets-this` | explain_styles |
| `element-wrong-size` | measure_element + inspect_ancestors(width/height) + explain_styles |
| `spacing-wrong` | explain_styles(margin/padding/gap) + measure_element |
| `alignment-off` | diagnose(not_centered) + measure_element (+ check_alignment for a group) |
| `flex-grid-layout` | inspect_element + explain_styles + inspect_ancestors |
| `element-hidden` | diagnose(invisible) + inspect_element |
| `overlap-z-index` | diagnose(overlapping) + inspect_ancestors(stacking) |
| `clipped-cutoff` | diagnose(clipped/overflowing) + inspect_ancestors(overflow) |
| `text-truncated` | measure_element + explain_styles(white-space) + inspect_ancestors |
| `font-wrong` | explain_styles(font) |
| `animation-broken` | explain_animations |
| `click-not-working` | diagnose(overlapping) + get_listeners (does **not** click — use record_interaction for that) |
| `hover-state-wrong` | style_diff record → interact(hover) → style_diff compare + explain_styles |
| `responsive-broken` | measure (+ explain) at each breakpoint, viewport restored afterwards |
| `positioned-wrong` | inspect_ancestors(position) + explain_styles(position) + measure_element |
| `find-element` | find_elements |
| `page-overview` | page_snapshot |
| `diagnose-issue` | diagnose(auto) + inspect_element — fallback when an element is given but no symptom is recognized |

`test/solve.test.ts` checks that every plan step's arguments pass the target tool's own schema, and pins ~30 realistic phrasings to their scenario.

## Firefox (extension, lite engine)

In a Firefox extension session solve uses the lite engine: the same scenarios map to a CSSOM cascade explainer (winner, losers, reasons, file:line), visibility/overlap/stacking facts, hit-testing, animations, snapshots and screenshots. Scenarios that need the DevTools Protocol (listeners, hover emulation, viewport emulation, inject_css) say so and suggest connecting via Chrome.

## Adding a scenario

Add an entry to `SCENARIOS` in `src/scenarios.ts`: `cues` (weighted regexes), `needs`, `ask`, a `plan(p)` that builds tool args from the resolved target, and a one-line `next`. The schema test will fail if a step passes an argument the tool doesn't accept. Add phrasings to the router table in `test/solve.test.ts`.
