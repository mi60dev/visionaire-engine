/**
 * MCP server assembly: three session tools owned here (connect / navigate /
 * set_viewport) plus the sixteen ToolDef tools from src/tools/. SPEC §4, §11, §14.
 */
import { createRequire } from 'node:module'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

// Version from package.json at runtime — ../package.json resolves from both dist/ and src/.
const PACKAGE_VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { SessionManager } from './session.js'
import type { ToolDef, ToolResult } from './types.js'
import { annotatedScreenshotTool } from './tools/annotated-screenshot.js'
import { assertVisualTool } from './tools/assert-visual.js'
import { captureProofTool } from './tools/capture-proof.js'
import { checkAlignmentTool } from './tools/check-alignment.js'
import { diagnoseTool } from './tools/diagnose.js'
import { evaluateTool } from './tools/evaluate.js'
import { impactPreviewTool } from './tools/impact-preview.js'
import { responsiveSweepTool } from './tools/responsive-sweep.js'
import { visualDiffTool } from './tools/visual-diff.js'
import { pickColorTool } from './tools/pick-color.js'
import { explainAnimationsTool } from './tools/explain-animations.js'
import { explainStylesTool } from './tools/explain-styles.js'
import { findElementsTool } from './tools/find-elements.js'
import { getListenersTool } from './tools/get-listeners.js'
import { inspectAncestorsTool } from './tools/inspect-ancestors.js'
import { injectCssTool } from './tools/inject-css.js'
import { inspectElementTool } from './tools/inspect-element.js'
import { interactTool } from './tools/interact.js'
import { measureElementTool } from './tools/measure-element.js'
import { nodeAtPointTool } from './tools/node-at-point.js'
import { pageOriginsTool } from './tools/page-origins.js'
import { pageSnapshotTool } from './tools/page-snapshot.js'
import { pickElementTool } from './tools/pick-element.js'
import { recordInteractionTool } from './tools/record-interaction.js'
import { styleDiffTool } from './tools/style-diff.js'

/** When-to-use descriptions surfaced to the calling LLM; fall back to the ToolDef's own. */
// Each description follows: WHAT it returns → WHEN to reach for it (concrete
// user-voiced symptoms) → which sibling tool to use instead for the near-miss
// case. This is what lets a calling LLM pick the right tool autonomously.
const DESCRIPTIONS: Record<string, string> = {
  page_snapshot:
    'Token-budgeted census of the rendered page — a nested, uid-keyed element tree with geometry and visibility flags. Call this FIRST after connect to orient yourself and to obtain the stable uids every other tool targets. Reach for it whenever you do not yet know the page structure or an element uid. To find one specific element by description use find_elements; to see the page visually use annotated_screenshot.',
  page_origins:
    "Inventory of every stylesheet (URL, byte size, origin, source-map presence) plus platform detection — WordPress version, theme/child theme, page builder (Elementor/Divi), and CSS optimizer. Use before proposing edits to learn where the CSS actually lives, when a file:line points at a generated/minified bundle and you need the true source, or to answer 'is this WordPress/Elementor?' and 'which stylesheet owns this?'.",
  inspect_element:
    "The 'WHAT' for one element: box model (margins/padding/border), key computed styles as authored → used values, a visibility verdict, and layout context. Use when you need an element's current rendered state — its real size, spacing, or whether it is actually visible/where it sits. These are the values the page ACTUALLY renders, so it catches the common case where the source rule you'd edit is overridden or never applied. For 'WHY it looks like this / which rule wins' use explain_styles; for 'which ancestor constrains its size or position' use inspect_ancestors.",
  explain_styles:
    "The core 'WHY': a per-property cascade verdict naming the winning CSS declaration and every loser with the exact reason it lost (specificity, !important, source order, inline, layer), each attributed to file:line or a WordPress/Elementor/Customizer origin. Reach for this whenever a style is wrong or 'won't apply' — wrong color/font/size/spacing, 'something is overriding my rule', 'where does this value come from', 'which rule do I edit'. Prefer this over grepping the source for a style bug: source search finds candidate rules, but only the live cascade shows which one actually WINS on a layered stack — so diagnose here before editing CSS you assume is the cause. Each winner also reports its BLAST RADIUS — how many other elements that rule styles (so you change THE button, not all buttons) — plus a scoped selector that targets just this element, with a specificity verdict. Pass an optional property (e.g. 'margin-bottom') to focus.",
  inspect_ancestors:
    "Walk an element's ancestor chain for ONE concern — width, height, position, overflow, or stacking — and flag the ancestor that is the binding constraint. Use when the cause lives ABOVE the element: it's too wide/narrow, clipped or cut off, won't scroll, is mysteriously positioned, or a z-index has no effect (trapped in an ancestor's stacking context). Complements explain_styles, which explains the element's own winning rules.",
  find_elements:
    "Deterministic search by visible text, CSS selector, ARIA role, and/or screen region → compact uid-keyed matches; anchors include their resolved href, so find_elements{role:'link'} lists the page's links WITH destinations (then navigate to browse them). Criteria are AND-combined by default; pass match:'any' for a union (OR) when over-specifying returns nothing, and visibleOnly:false to include display:none/hidden elements. Use to locate the element a user described in words ('the Subscribe button', 'the header nav') before inspecting it. Prefer this (or page_snapshot) over guessing a selector. For a point in a screenshot use node_at_point; to have the human physically click the element use pick_element.",
  node_at_point:
    'Map viewport coordinates (x, y) to the element there: uid, identity, and the full ancestor uid chain. Use to turn a coordinate — e.g. a spot you located in an annotated_screenshot, or pixel coords the user gave — into a concrete element and uid.',
  annotated_screenshot:
    "Screenshot in two modes: an overview with numbered marks burned in, where mark N equals uid eN (mark 17 = e17); or an element-scoped crop via clipTo (uid|selector|x,y) with optional padding, scale (0.5..4 zoom for tiny elements), and annotate:false for a clean unlabeled crop. Use when text tools are not enough and you need to SEE the page while keeping pixels tied to elements — spatial or visual-layout questions ('things overlap', 'the layout looks off'), to zoom in on one small element, or to confirm which element is which. Then target elements by their uid.",
  style_diff:
    "BEFORE/AFTER comparison for one element: record its styles into a named slot, change something, compare — only the properties that changed are reported. Reach for it whenever you ask 'did my fix actually change anything?' or need to prove what an edit / inject_css patch / viewport change / interaction altered. The loop: style_diff{mode:'record'} → apply the change → style_diff{mode:'compare'}. Confirms a fix moved exactly the property you intended, and nothing else.",
  assert_visual:
    "THE verification gate — call it after EVERY visual edit instead of claiming success from reading code. State verifiable rendered-geometry claims (equal_height, equal_width, aligned_edges, centered, gap_equals, spacing_equals, visible, not_clipped, not_overlapped, within_viewport, color_equals, color_near, z_above, text_not_truncated, text_not_overflowing, size_equals, positioned) and get a deterministic per-assertion PASS/FAIL with the measured pixels and the offending uids — 'FAIL: e87 412px vs e91 388px' ends the argument. Pass suite_id to register the set as a named regression suite; later call with ONLY {suite_id} to re-run it against the current render, or hand it to responsive_sweep for a per-viewport matrix. Never claim a visual fix works without a PASS from this tool.",
  visual_diff:
    "Deterministic screenshot diff of the CURRENT render (page or one element) against a reference image — a user-supplied mockup (reference: { image_path }) or a named pixel baseline recorded earlier with style_diff { capture_pixels: true } (reference: { baseline_slot }). Returns MATCH/DIVERGENT with divergence_pct, the worst NxN grid regions mapped back to likely element uids, and an optional diff-heatmap PNG written to disk as a file path (never inline). Reach for it on 'make it match the mockup' or to catch any unintended pixel change after an edit; tune threshold / ignore_antialiasing / mask_dynamic for environment noise. For geometry claims (heights, alignment, spacing) prefer assert_visual — it is OS-stable integer math; pixel diffing is inherently environment-sensitive.",
  impact_preview:
    "Blast-radius report to run BEFORE editing a shared selector: every element '.nav-item' currently matches on the open page — true match count, uids, identities, screen regions, grouped by visual role — so you see that the footer shares the class before you warp it. Pass proposed_change: { declarations: {'padding':'20px'} } for a sandboxed dry-run that predicts exactly which matched elements' computed values would change and which are protected by more specific rules. Scope honesty: current page, current viewport only (other routes/viewports/interactive states are invisible here — use responsive_sweep for viewports). Use it whenever a fix edits a class used in more than one place.",
  diagnose:
    "One-shot 'why is this broken': give it an element (uid/selector/x,y) and an optional symptom — clipped, overflowing, not_centered, invisible, overlapping, wrong_size, or auto — and get a ranked culprit list in plain language with deterministic measured evidence ('ancestor e2 has overflow:hidden; content exceeds it by 34px on the right'). auto runs the cheap ordered battery and reports what trips. THE tool to call when assert_visual returns FAIL and you need the cause, or when the user says 'it looks broken' without saying why. Fix the named culprit, then re-run assert_visual.",
  responsive_sweep:
    "Re-run a verification across viewports in ONE call and get a per-viewport verdict matrix — the cure for 'looks right at 1280, broken on mobile'. run: { suite_id } re-runs a registered assert_visual suite (selectors re-resolve at each width), run: { assertions: [...] } runs inline claims, run: { diagnose: {...} } probes a symptom per viewport. Defaults to 375/768/1280/1920; passing cells collapse to PASS, failing cells carry the failed assertions with measured values; the original viewport is restored afterwards. Run it before claiming any responsive work is done.",
  capture_proof:
    "Before/after evidence bundle proving a fix worked: call with phase:'before' ahead of the change and phase:'after' once assert_visual passes — each phase captures an annotated screenshot (marked with your target uids, saved to disk as file paths) and, with suite_id, attaches the suite verdict; the 'after' call returns a verdict_delta (FAIL→PASS per assertion). Use it to close the loop with humans: 'here is the before, the after, and the measured verdicts'. Bundles persist under the artifacts dir keyed by bundle_id.",
  check_alignment:
    "DEPRECATED — use assert_visual (aligned_edges / equal_height / equal_width / spacing_equals assertions), which adds PASS/FAIL verdicts and re-runnable suites. Still functional for one release: pixel-perfect audit for a GROUP of elements (a selector's matches or a uid list): which edges/centers align and which element is off by how many px, gap rhythm with outliers, size consistency, optional N-px grid conformance, and pixel-snap warnings.",
  pick_color:
    "Sample the ACTUAL painted pixel at a point or element — the composited truth that computed styles cannot give (gradients, background images, opacity stacks, blend modes) — plus the owning element's computed color/background and a WCAG contrast verdict (AA/AAA) of the text against the painted backdrop. Reach for it on 'the color looks off', 'is this the exact brand hex?', 'is this text readable on that background?'. Use at:'top-left' to sample pure background (center may hit a glyph); use explain_styles to find WHICH RULE set a wrong color.",
  inject_css:
    "Apply CSS to the LIVE page without touching source files — either declarations trialed on one element (applied !important so the trial always wins; reports which computed properties changed) or a raw page-wide rule block. THE fix-loop tool: explain_styles names the winning rule → inject_css the candidate fix → verify with measure_element/style_diff/annotated_screenshot → write the final declarations into the source once → revert:'all'. This replaces the slow edit-file → cache-bust → reload → re-snapshot cycle. Also the quick way to hide a cookie/consent overlay that occludes what you need (inject 'display:none'). Patches are trial-only: gone on navigation or revert.",
  pick_element:
    'Let the human point at the element: turns on a DevTools-style hover highlight in the connected tab and waits for them to click, returning the clicked element\'s uid and ancestor chain. Use when the user says "I\'ll show you" / "let me click it", or when find_elements/annotated_screenshot could not pin down the element from a description. Needs a visible browser window (connect { headless: false }).',
  get_listeners:
    'List the event listeners on an element — and, by default, delegated listeners up the ancestor chain, document, and window: event type, handler file:line (source-mapped, WordPress-origin-labeled), and the bug-prone flags capture/passive/once. Use to answer "which JS file handles this button?", or when a click/submit/keypress does nothing, a form won\'t submit, or preventDefault is ignored (often a passive listener). For what actually happens step-by-step when clicked, use record_interaction.',
  explain_animations:
    'Explain the animations and transitions on one element: a census of what is running right now (type, play state, timing, animated properties) plus the declared transition/animation/@keyframes rules attributed to file:line, checked against a closed ruleset of known causes. Use when an animation or transition is not smooth, does not run at all, or jumps/pops instead of animating; pass the optional property (e.g. "opacity") to check why THAT property does not animate. For a timeline of a specific click/hover (what fired, what got cancelled), use record_interaction.',
  record_interaction:
    'Perform one interaction (click or hover, or watch while the human interacts) and return a source-attributed causal TIMELINE — handler file:line, DOM/class mutations, animations started/cancelled, layout shifts, console errors — uid-keyed and time-ordered. Use for cause-and-effect over time: "the sidebar does not hide smoothly", "nothing/the wrong thing happens when I click", "the menu closes immediately", a modal that won\'t open, focus that jumps. For static listener attribution without triggering it, use get_listeners; for animation rules at rest, use explain_animations.',
  interact:
    'Perform ONE action (click/hover/focus) at a target and LEAVE the resulting state in place — no recording, no teardown. Use this to DRIVE the UI into a state — open a popup/menu/modal, reveal a tab or dropdown — so you can then inspect_element / annotated_screenshot / explain_styles the NEW state: "open the menu then tell me why it overflows", "click the tab and check the panel". Reports the target\'s post-action visibility + content box so you learn immediately whether it opened. Target by uid, selector, or x+y. For the causal TIMELINE of an interaction — which handler ran, what mutated, which transitions were cancelled — use record_interaction instead; interact only leaves you in the state, it does not explain the transition.',
  measure_element:
    'Deterministic rendered-pixel geometry: an element\'s content box (WxH @x,y) and the true TEXT INK bounding box of its glyphs (canvas measureText extents, not the advance box), plus a sub-pixel centering verdict — how far the ink sits from the content-box center on each axis, with a padding/line-height fix hint. Reach for this when the caller is fussing over VISUAL alignment that the box model can\'t see: "the × in the close button looks a bit high/off-center", "the icon is not quite centered", one-off pixel offsets. Pass referenceUid/referenceSelector to also get the center delta between two elements. explain_styles tells you which rule set the value; measure_element tells you whether the painted glyph actually lands where you want.',
  evaluate:
    'ESCAPE HATCH — run arbitrary agent-authored JavaScript in the page and get the JSON result. Use ONLY when no purpose-built tool covers the need: a custom measurement, forcing a UI state (dispatch an event / toggle a class), or reading framework/component state. Prefer explain_styles / measure_element / inspect_element / interact where they apply — reach for evaluate when the question is genuinely bespoke and none of them fits. The JS is trusted (you wrote it); its result is returned verbatim and size-capped.',
}

function ok(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] }
}

function toCallToolResult(result: ToolResult): CallToolResult {
  const content: CallToolResult['content'] = [{ type: 'text', text: result.text }]
  for (const img of result.images ?? []) {
    content.push({ type: 'image', data: img.data, mimeType: img.mimeType })
  }
  return { content }
}

function errorResult(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err)
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
}

/** Watchdog: a wedged tool call must fail fast with an actionable message, never hang the MCP client (field report: 4-minute client timeouts). */
const TOOL_TIMEOUT_MS = Math.max(5_000, Number(process.env['VISIONAIRE_TOOL_TIMEOUT_MS']) || 60_000)

export async function withWatchdog<T>(name: string, run: () => Promise<T>, timeoutMs = TOOL_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `${name} did not respond within ${Math.round(timeoutMs / 1000)}s — the browser/page may be wedged. ` +
                  'Run connect again to reset the session (VISIONAIRE_TOOL_TIMEOUT_MS overrides this limit).',
              ),
            ),
          timeoutMs,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Tools with legitimate long waits get their declared budget + slack instead of the default. */
function timeoutBudgetMs(name: string, args: Record<string, unknown>): number {
  const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
  if (name === 'pick_element') {
    const waitS = Math.min(600, Math.max(5, num(args.timeoutSeconds, 60)))
    return waitS * 1000 + 15_000
  }
  if (name === 'record_interaction') {
    const waitMs = Math.min(10_000, Math.max(200, num(args.waitMs, 1500)))
    return Math.max(TOOL_TIMEOUT_MS, waitMs + 45_000)
  }
  return TOOL_TIMEOUT_MS
}

function registerToolDef(server: McpServer, session: SessionManager, def: ToolDef): void {
  server.registerTool(
    def.name,
    { description: DESCRIPTIONS[def.name] ?? def.description, inputSchema: def.inputSchema },
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      try {
        const result = await withWatchdog(
          def.name,
          () => def.handler(session.context(), args ?? {}),
          timeoutBudgetMs(def.name, args ?? {}),
        )
        return toCallToolResult(result)
      } catch (err) {
        return errorResult(err)
      }
    },
  )
}

const SERVER_INSTRUCTIONS = [
  'visionaire-engine gives deterministic "why" facts about a LIVE web page: cascade winners with',
  'file:line, visibility causes, event-listener/animation/interaction attribution. No AI inside —',
  'you do the fuzzy reasoning.',
  '',
  'WHEN TO GO LIVE (do not skip this): for any bug about how something LOOKS or BEHAVES — wrong',
  "color/size/spacing, misalignment, a style that 'won't apply' or is overridden, overlap, an",
  'animation or interaction — inspect the RENDERED page here (explain_styles / inspect_element /',
  'measure_element / interact) BEFORE editing source. On real stacks (plugin + parent + child theme,',
  '!important, inline, Elementor, media queries) the source holds many candidate rules but only the',
  'live cascade reveals which one WINS and where — a blind grep-and-edit frequently changes a rule',
  "that isn't the winner and wastes a round-trip. Reading source alone is right only for a known,",
  'unconditional edit (rename, add a comment, a value you are certain of). This tool is usually',
  'faster than guessing from source for visual/behavioral bugs.',
  '',
  'Ground yourself BEFORE targeting elements — do not guess CSS selectors. A selector that is not in',
  'the live DOM just wastes a round-trip. Instead:',
  '  1. call `connect`, then `page_snapshot` to get the real uid-keyed element tree;',
  '  2. target elements by `uid` from that snapshot (stable until navigation), or use `find_elements`',
  '     (by text/role/region) or `node_at_point` — not invented selectors;',
  '  3. you typically also have this project\'s SOURCE on disk — read it to find the actual class/id',
  '     names, template, and handler files before searching the page.',
  '',
  'To TEST a candidate fix, do not edit files and reload: inject_css applies declarations to the live page',
  '(revertable, !important trial) — verify with measure_element / style_diff, converge, THEN write the final',
  'declarations into the source once. If a stale stylesheet keeps being served, navigate { bypassCache: true }.',
  '',
  'Run this server from the project\'s root directory so the live page and the source you read line up.',
  'When a selector matches nothing, the error suggests the closest real ids/classes on the page.',
].join('\n')

export function createServer(session: SessionManager): McpServer {
  const server = new McpServer(
    { name: 'visionaire-engine', version: PACKAGE_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  )

  server.registerTool(
    'connect',
    {
      description:
        'ALWAYS the first call: start (or restart) the browser session — launch a local Chrome by default, or attach to the user\'s real, logged-in browser via browserUrl (e.g. http://127.0.0.1:9222, for pages behind auth like wp-admin or a dashboard). Pass url to load a page immediately. Every other tool needs a live session; if a tool reports no session or a wedged browser, call connect again to reset.',
      inputSchema: {
        mode: z.enum(['launch', 'attach']).optional().describe("Default 'launch'; 'attach' joins a running Chrome"),
        url: z.string().optional().describe('Navigate here right after connecting'),
        browserUrl: z.string().optional().describe('DevTools HTTP endpoint for attach mode, e.g. http://127.0.0.1:9222'),
        headless: z.boolean().optional().describe('Launch mode only; default false (visible window)'),
        width: z.number().int().positive().optional().describe('Viewport width, default 1280'),
        height: z.number().int().positive().optional().describe('Viewport height, default 800'),
      },
    },
    async (args): Promise<CallToolResult> => {
      try {
        const ctx = await session.connect(args)
        const version = await ctx.page.browser().version()
        const viewport = ctx.page.viewport()
        const vp = viewport ? `${viewport.width}x${viewport.height}` : 'browser window size'
        const mode = args.mode ?? (args.browserUrl ? 'attach' : 'launch')
        return ok(
          `connected (${mode}) — ${version} — viewport ${vp}\nurl: ${ctx.page.url()}\n` +
            `working dir: ${process.cwd()}\n` +
            'next: page_snapshot to get real uids — target by uid, not guessed selectors ' +
            "(read this project's source for actual class/id names).",
        )
      } catch (err) {
        return errorResult(err)
      }
    },
  )

  server.registerTool(
    'navigate',
    {
      description:
        'Navigate the connected tab to a URL — or, with no url, hard-reload the current page. Pass bypassCache: true when a stale cached stylesheet/script keeps being served (disables the browser cache for the rest of the session). All element uids from earlier snapshots become stale — take a fresh page_snapshot afterwards.',
      inputSchema: {
        url: z.string().optional().describe('Absolute URL to load; omit to reload the current page'),
        bypassCache: z
          .boolean()
          .optional()
          .describe('Disable the browser cache for the rest of the session (fresh CSS/JS on every load)'),
      },
    },
    async (args): Promise<CallToolResult> => {
      try {
        if (args.bypassCache) await session.disableCache()
        if (args.url) await session.navigate(args.url)
        else await session.reload(args.bypassCache === true)
        const cacheNote = args.bypassCache ? ' (browser cache disabled for this session)' : ''
        return ok(
          `${args.url ? 'navigated to' : 'reloaded'} ${session.context().page.url()}${cacheNote} — previous uids are stale; take a fresh page_snapshot.`,
        )
      } catch (err) {
        return errorResult(err)
      }
    },
  )

  server.registerTool(
    'set_viewport',
    {
      description:
        "Emulate a viewport size (and optional deviceScaleFactor) on the connected tab, then re-inspect. Use for responsive bugs — 'it breaks on mobile', 'the menu is wrong at tablet width', anything behind a media query — since resizing can change which @media rule wins. Follow with a fresh page_snapshot / explain_styles at the new size.",
      inputSchema: {
        width: z.number().int().positive().describe('Viewport width in CSS px'),
        height: z.number().int().positive().describe('Viewport height in CSS px'),
        deviceScaleFactor: z.number().positive().optional().describe('Default 1'),
      },
    },
    async (args): Promise<CallToolResult> => {
      try {
        await session.setViewport(args.width, args.height, args.deviceScaleFactor)
        return ok(`viewport set to ${args.width}x${args.height}@${args.deviceScaleFactor ?? 1}x`)
      } catch (err) {
        return errorResult(err)
      }
    },
  )

  const toolDefs: ToolDef[] = [
    pageSnapshotTool,
    pageOriginsTool,
    inspectElementTool,
    explainStylesTool,
    inspectAncestorsTool,
    findElementsTool,
    nodeAtPointTool,
    annotatedScreenshotTool,
    styleDiffTool,
    pickElementTool,
    getListenersTool,
    explainAnimationsTool,
    recordInteractionTool,
    interactTool,
    measureElementTool,
    evaluateTool,
    injectCssTool,
    assertVisualTool,
    visualDiffTool,
    impactPreviewTool,
    diagnoseTool,
    responsiveSweepTool,
    captureProofTool,
    checkAlignmentTool,
    pickColorTool,
  ]
  for (const def of toolDefs) registerToolDef(server, session, def)

  return server
}
