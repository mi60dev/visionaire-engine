/**
 * MCP server assembly: three session tools owned here (connect / navigate /
 * set_viewport) plus the ten ToolDef tools from src/tools/. SPEC §4, §11.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { SessionManager } from './session.js'
import type { ToolDef, ToolResult } from './types.js'
import { annotatedScreenshotTool } from './tools/annotated-screenshot.js'
import { explainStylesTool } from './tools/explain-styles.js'
import { findElementsTool } from './tools/find-elements.js'
import { inspectAncestorsTool } from './tools/inspect-ancestors.js'
import { inspectElementTool } from './tools/inspect-element.js'
import { nodeAtPointTool } from './tools/node-at-point.js'
import { pageOriginsTool } from './tools/page-origins.js'
import { pageSnapshotTool } from './tools/page-snapshot.js'
import { pickElementTool } from './tools/pick-element.js'
import { styleDiffTool } from './tools/style-diff.js'

/** When-to-use descriptions surfaced to the calling LLM; fall back to the ToolDef's own. */
const DESCRIPTIONS: Record<string, string> = {
  page_snapshot:
    'Take a token-budgeted census of the rendered page: a nested element tree with stable uids, geometry, and visibility. Use this first to orient yourself and to obtain uids for every other tool.',
  page_origins:
    'Inventory every stylesheet on the page (URL, byte size, origin classification, source-map presence) and detect the platform: WordPress version, theme, page builders, optimizers. Use it to learn where the CSS comes from before proposing edits.',
  inspect_element:
    "Get the 'what' for one element: box model, key computed styles as authored → used pairs, visibility verdict, and layout context. Use when you need an element's current rendered state.",
  explain_styles:
    "Explain WHY an element looks the way it does: per-property cascade verdicts naming the winning declaration and each loser with the reason it lost, every rule attributed to its file:line or WordPress/database origin. Use this to find exactly which rule to edit.",
  inspect_ancestors:
    'Walk the ancestor chain for one concern (width, height, position, overflow, or stacking) and flag the binding constraint. Use when an element is sized, clipped, or stacked by something above it.',
  find_elements:
    'Deterministically search the page by text, CSS selector, role, and/or screen region, returning compact uid-keyed matches. Use to locate the element a user described before inspecting it.',
  node_at_point:
    'Map viewport coordinates (x, y) to the element at that point: uid, identity, and the full ancestor uid chain. Use to ground a spot in a screenshot to a concrete element.',
  annotated_screenshot:
    'Capture a screenshot with numbered marks burned in; mark numbers equal snapshot uid numbers (mark 17 = uid e17). Use when you need to see the page and tie pixels back to elements.',
  style_diff:
    "Record an element's styles into a named slot, then compare later and see only the changed properties. Use for verify-my-fix loops: record, apply the change, compare.",
  pick_element:
    'Let the human point at the element: turns on a DevTools-style hover highlight in the connected tab and waits for them to click, returning the clicked element\'s uid and ancestor chain. Use when the user says "I\'ll show you" / "let me click it", or when find_elements/screenshot grounding failed to pin down the element. Needs a visible browser window (connect { headless: false }).',
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

function registerToolDef(server: McpServer, session: SessionManager, def: ToolDef): void {
  server.registerTool(
    def.name,
    { description: DESCRIPTIONS[def.name] ?? def.description, inputSchema: def.inputSchema },
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      try {
        const result = await def.handler(session.context(), args ?? {})
        return toCallToolResult(result)
      } catch (err) {
        return errorResult(err)
      }
    },
  )
}

export function createServer(session: SessionManager): McpServer {
  const server = new McpServer({ name: 'visionaire-engine', version: '0.1.0' })

  server.registerTool(
    'connect',
    {
      description:
        'Start (or restart) the browser session: launch a local Chrome by default, or attach to a running one via browserUrl (e.g. http://127.0.0.1:9222). Call this before any other tool; pass url to navigate immediately.',
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
        return ok(`connected (${mode}) — ${version} — viewport ${vp}\nurl: ${ctx.page.url()}`)
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
        'Emulate a viewport size (and optional deviceScaleFactor) on the connected tab for responsive debugging, then re-inspect: media-query winners may change.',
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
  ]
  for (const def of toolDefs) registerToolDef(server, session, def)

  return server
}
