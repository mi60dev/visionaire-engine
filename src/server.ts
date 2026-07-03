/**
 * MCP server assembly: three session tools owned here (connect / navigate /
 * set_viewport) plus the thirteen ToolDef tools from src/tools/. SPEC §4, §11, §14.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { SessionManager } from './session.js'
import type { ToolDef, ToolResult } from './types.js'
import { annotatedScreenshotTool } from './tools/annotated-screenshot.js'
import { explainAnimationsTool } from './tools/explain-animations.js'
import { explainStylesTool } from './tools/explain-styles.js'
import { findElementsTool } from './tools/find-elements.js'
import { getListenersTool } from './tools/get-listeners.js'
import { inspectAncestorsTool } from './tools/inspect-ancestors.js'
import { inspectElementTool } from './tools/inspect-element.js'
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
    "The 'WHAT' for one element: box model (margins/padding/border), key computed styles as authored → used values, a visibility verdict, and layout context. Use when you need an element's current rendered state — its real size, spacing, or whether it is actually visible/where it sits. For 'WHY it looks like this / which rule wins' use explain_styles; for 'which ancestor constrains its size or position' use inspect_ancestors.",
  explain_styles:
    "The core 'WHY': a per-property cascade verdict naming the winning CSS declaration and every loser with the exact reason it lost (specificity, !important, source order, inline, layer), each attributed to file:line or a WordPress/Elementor/Customizer origin. Reach for this whenever a style is wrong or 'won't apply' — wrong color/font/size/spacing, 'something is overriding my rule', 'where does this value come from', 'which rule do I edit'. Pass an optional property (e.g. 'margin-bottom') to focus. This is the tool for style-cause questions.",
  inspect_ancestors:
    "Walk an element's ancestor chain for ONE concern — width, height, position, overflow, or stacking — and flag the ancestor that is the binding constraint. Use when the cause lives ABOVE the element: it's too wide/narrow, clipped or cut off, won't scroll, is mysteriously positioned, or a z-index has no effect (trapped in an ancestor's stacking context). Complements explain_styles, which explains the element's own winning rules.",
  find_elements:
    "Deterministic search by visible text, CSS selector, ARIA role, and/or screen region → compact uid-keyed matches. Use to locate the element a user described in words ('the Subscribe button', 'the header nav') before inspecting it. Prefer this (or page_snapshot) over guessing a selector. For a point in a screenshot use node_at_point; to have the human physically click the element use pick_element.",
  node_at_point:
    'Map viewport coordinates (x, y) to the element there: uid, identity, and the full ancestor uid chain. Use to turn a coordinate — e.g. a spot you located in an annotated_screenshot, or pixel coords the user gave — into a concrete element and uid.',
  annotated_screenshot:
    "Screenshot with numbered marks burned in, where mark N equals uid eN (mark 17 = e17). Use when text tools are not enough and you need to SEE the page while keeping pixels tied to elements — spatial or visual-layout questions ('things overlap', 'the layout looks off'), or to confirm which element is which. Then target elements by their uid.",
  style_diff:
    "Record one element's styles into a named slot, then compare later to report only the properties that changed. Use for verify-my-fix loops (record → apply the edit → compare) and to see what a viewport change or an interaction altered. Confirms a fix actually moved the property you intended, and nothing else.",
  pick_element:
    'Let the human point at the element: turns on a DevTools-style hover highlight in the connected tab and waits for them to click, returning the clicked element\'s uid and ancestor chain. Use when the user says "I\'ll show you" / "let me click it", or when find_elements/annotated_screenshot could not pin down the element from a description. Needs a visible browser window (connect { headless: false }).',
  get_listeners:
    'List the event listeners on an element — and, by default, delegated listeners up the ancestor chain, document, and window: event type, handler file:line (source-mapped, WordPress-origin-labeled), and the bug-prone flags capture/passive/once. Use to answer "which JS file handles this button?", or when a click/submit/keypress does nothing, a form won\'t submit, or preventDefault is ignored (often a passive listener). For what actually happens step-by-step when clicked, use record_interaction.',
  explain_animations:
    'Explain the animations and transitions on one element: a census of what is running right now (type, play state, timing, animated properties) plus the declared transition/animation/@keyframes rules attributed to file:line, checked against a closed ruleset of known causes. Use when an animation or transition is not smooth, does not run at all, or jumps/pops instead of animating; pass the optional property (e.g. "opacity") to check why THAT property does not animate. For a timeline of a specific click/hover (what fired, what got cancelled), use record_interaction.',
  record_interaction:
    'Perform one interaction (click or hover, or watch while the human interacts) and return a source-attributed causal TIMELINE — handler file:line, DOM/class mutations, animations started/cancelled, layout shifts, console errors — uid-keyed and time-ordered. Use for cause-and-effect over time: "the sidebar does not hide smoothly", "nothing/the wrong thing happens when I click", "the menu closes immediately", a modal that won\'t open, focus that jumps. For static listener attribution without triggering it, use get_listeners; for animation rules at rest, use explain_animations.',
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
  'Ground yourself BEFORE targeting elements — do not guess CSS selectors. A selector that is not in',
  'the live DOM just wastes a round-trip. Instead:',
  '  1. call `connect`, then `page_snapshot` to get the real uid-keyed element tree;',
  '  2. target elements by `uid` from that snapshot (stable until navigation), or use `find_elements`',
  '     (by text/role/region) or `node_at_point` — not invented selectors;',
  '  3. you typically also have this project\'s SOURCE on disk — read it to find the actual class/id',
  '     names, template, and handler files before searching the page.',
  '',
  'Run this server from the project\'s root directory so the live page and the source you read line up.',
  'When a selector matches nothing, the error suggests the closest real ids/classes on the page.',
].join('\n')

export function createServer(session: SessionManager): McpServer {
  const server = new McpServer(
    { name: 'visionaire-engine', version: '0.1.0' },
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
        'Navigate the connected tab to a URL. All element uids from earlier snapshots become stale — take a fresh page_snapshot afterwards.',
      inputSchema: { url: z.string().describe('Absolute URL to load') },
    },
    async (args): Promise<CallToolResult> => {
      try {
        await session.navigate(args.url)
        return ok(`navigated to ${session.context().page.url()} — previous uids are stale; take a fresh page_snapshot.`)
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
  ]
  for (const def of toolDefs) registerToolDef(server, session, def)

  return server
}
