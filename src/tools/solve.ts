/**
 * solve — the single gateway into the engine.
 *
 * Three ways in:
 *   1. intent only            → deterministic keyword routing to a scenario plan
 *   2. intent + scenario      → skip routing (ids listed in the schema)
 *   3. tool + args            → run one engine tool directly (expert mode)
 *
 * Every answer leads with the route taken and the resolved target, then the
 * evidence from each step, then one concrete NEXT action. When the target is
 * missing or routing is unsure, solve asks (with candidates) instead of guessing.
 */
import { z } from 'zod'
import type { SessionManager } from '../session.js'
import type { ToolContext, ToolDef, ToolResult } from '../types.js'
import { inferProperty, routeQuery } from '../keyword-router.js'
import { getScenario, SCENARIO_IDS, SCENARIOS, type PlanInput, type PlanStep, type Scenario } from '../scenarios.js'
import type { LiteSession, LiteTarget } from '../bridge/lite.js'

import { pageSnapshotTool } from './page-snapshot.js'
import { pageOriginsTool } from './page-origins.js'
import { inspectElementTool } from './inspect-element.js'
import { explainStylesTool } from './explain-styles.js'
import { inspectAncestorsTool } from './inspect-ancestors.js'
import { findElementsTool } from './find-elements.js'
import { nodeAtPointTool } from './node-at-point.js'
import { annotatedScreenshotTool } from './annotated-screenshot.js'
import { styleDiffTool } from './style-diff.js'
import { pickElementTool } from './pick-element.js'
import { getListenersTool } from './get-listeners.js'
import { explainAnimationsTool } from './explain-animations.js'
import { recordInteractionTool } from './record-interaction.js'
import { interactTool } from './interact.js'
import { measureElementTool } from './measure-element.js'
import { evaluateTool } from './evaluate.js'
import { injectCssTool } from './inject-css.js'
import { assertVisualTool } from './assert-visual.js'
import { visualDiffTool } from './visual-diff.js'
import { impactPreviewTool } from './impact-preview.js'
import { diagnoseTool } from './diagnose.js'
import { responsiveSweepTool } from './responsive-sweep.js'
import { captureProofTool } from './capture-proof.js'
import { checkAlignmentTool } from './check-alignment.js'
import { pickColorTool } from './pick-color.js'

/** Engine tools reachable through solve. */
export const TOOL_HANDLERS: Record<string, ToolDef> = Object.fromEntries(
  [
    pageSnapshotTool, pageOriginsTool, inspectElementTool, explainStylesTool, inspectAncestorsTool,
    findElementsTool, nodeAtPointTool, annotatedScreenshotTool, styleDiffTool, pickElementTool,
    getListenersTool, explainAnimationsTool, recordInteractionTool, interactTool, measureElementTool,
    evaluateTool, injectCssTool, assertVisualTool, visualDiffTool, impactPreviewTool, diagnoseTool,
    responsiveSweepTool, captureProofTool, checkAlignmentTool, pickColorTool,
  ].map((t) => [t.name, t]),
)
const TOOL_NAMES = Object.keys(TOOL_HANDLERS) as [string, ...string[]]

/** One line per tool for the schema description (the LLM's map of expert mode). */
const TOOL_SUMMARY = Object.values(TOOL_HANDLERS)
  .map((t) => `${t.name}(${Object.keys(t.inputSchema).join(',')})`)
  .join('; ')

const contextSchema = z
  .object({
    element: z
      .string()
      .optional()
      .describe('Target element: a uid (e12, or f12 in Firefox), a CSS selector, or a short text description ("Subscribe button")'),
    elements: z.string().optional().describe('A CSS selector matching a GROUP of elements (alignment checks)'),
    property: z.string().optional().describe('CSS property of interest, e.g. "color", "padding", "z-index"'),
    viewport: z
      .object({ width: z.number().int().positive(), height: z.number().int().positive() })
      .optional()
      .describe('Emulate this viewport before inspecting'),
    reference_element: z.string().optional().describe('Second element to compare/align against'),
    breakpoints: z.array(z.number().int().positive()).optional().describe('Widths for responsive checks (default 375/768/1280)'),
  })
  .optional()

const inputSchema = {
  intent: z.string().min(1).describe('The problem in plain language, e.g. "why is the header CTA blue instead of white"'),
  scenario: z
    .enum(SCENARIO_IDS)
    .optional()
    .describe('Skip routing and run this scenario: ' + SCENARIOS.map((s) => s.id).join(', ')),
  context: contextSchema.describe('Target and details; solve asks for what is missing'),
  tool: z
    .enum(TOOL_NAMES)
    .optional()
    .describe('Expert mode — run ONE engine tool directly with `args` (intent is still required, as a note). Tools: ' + TOOL_SUMMARY),
  args: z.record(z.unknown()).optional().describe('Arguments for `tool` (expert mode)'),
}

type SolveInput = z.infer<z.ZodObject<typeof inputSchema>>
type Ctx = NonNullable<SolveInput['context']>

export function solveTool(session: SessionManager): ToolDef {
  return {
    name: 'solve',
    description:
      '**START HERE** for any visual/behavioral question about the connected page. Describe the problem in plain language ' +
      '("button is blue instead of white", "modal hidden behind overlay", "menu breaks at 768px") and pass context.element ' +
      '(uid, selector, or text). solve routes to a diagnostic plan, runs it, and answers with the winning rule file:line, ' +
      'visibility/overlap causes, measurements, listeners or animations — plus one NEXT step. Unsure routing returns ' +
      'candidates; pass `scenario` to force one, or `tool`+`args` to run one engine tool directly.',
    inputSchema,
    handler: async (_ctx, args) => {
      const parsed = z.object(inputSchema).safeParse(args)
      if (!parsed.success) {
        return { text: `Invalid solve input: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}` }
      }
      return handleSolve(session, parsed.data)
    },
  }
}

async function handleSolve(session: SessionManager, input: SolveInput): Promise<ToolResult> {
  if (!session.connected) {
    const lost = session.lostSessionReason
    if (lost) return { text: `The extension session ended: ${lost}. Call connect again to resume.` }
    return {
      text:
        'Not connected to a page. Call connect first — e.g. connect({url}) to launch a local Chrome, or ' +
        'connect({mode:"extension", url}) to inspect it in the user\'s own browser via the Visionaire extension.',
    }
  }
  if (session.lite) return liteSolve(session.lite, input)
  const ctx = session.context()

  if (input.tool) {
    const refusal = extensionModeRefusal(session, input.tool, input.args ?? {})
    if (refusal) return { text: refusal }
    return runDirect(ctx, input.tool, input.args ?? {})
  }

  // ── route ──
  let scenario: Scenario | undefined
  let routeNote = ''
  if (input.scenario) {
    scenario = getScenario(input.scenario)
  } else {
    const route = routeQuery(input.intent)
    if (route.best && route.best.score >= 3) {
      scenario = route.best.scenario
      const others = route.candidates.slice(1).filter((c) => c.score >= 3)
      if (!route.confident && others.length) {
        routeNote = `also matched: ${others.map((c) => c.scenario.id).join(', ')} — pass scenario to force one`
      }
    } else if (input.context?.element) {
      scenario = getScenario('diagnose-issue')
      routeNote = 'no specific symptom recognized — running general triage'
    } else {
      return { text: candidatesText(input.intent, route.candidates.map((c) => c.scenario)) }
    }
  }
  if (!scenario) return { text: `Unknown scenario "${input.scenario}". Valid: ${SCENARIO_IDS.join(', ')}` }

  // ── resolve target ──
  const c: Ctx = input.context ?? {}
  let target: Record<string, unknown> | undefined
  let targetNote = ''
  if (c.element) {
    const r = await resolveElement(ctx, c.element)
    if ('error' in r) return { text: header(scenario, routeNote) + `\n\n${r.error}` }
    target = r.target
    targetNote = r.note
  }
  if (scenario.needs === 'element' && !target) {
    const snap = await pageSnapshotTool.handler(ctx, { budgetTokens: 1200 }).catch(() => undefined)
    return {
      text:
        header(scenario, routeNote) +
        `\n\nNEED: ${scenario.ask ?? 'Which element?'} Call solve again with the same intent and context.element = a uid from the outline below (or a selector / visible text).` +
        (snap ? `\n\n${snap.text}` : ''),
    }
  }
  let reference: Record<string, unknown> | undefined
  if (c.reference_element) {
    const r = await resolveElement(ctx, c.reference_element)
    if (!('error' in r)) reference = r.target
  }

  const plan = scenario.plan({
    intent: input.intent.toLowerCase(),
    target,
    reference,
    property: c.property ?? inferProperty(input.intent),
    viewport: c.viewport,
    breakpoints: c.breakpoints,
    selector: c.elements,
  } satisfies PlanInput)

  // ── execute ──
  const sections: string[] = []
  const images: NonNullable<ToolResult['images']> = []
  const log: string[] = []
  for (const s of plan) {
    try {
      const res = await runStep(session, ctx, s, target)
      sections.push(`── ${s.tool} ──\n${res.text.trim()}`)
      if (res.images) images.push(...res.images)
      log.push(`${s.tool} ✓`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.push(`${s.tool} ✗`)
      sections.push(`── ${s.tool} ✗ ──\n${msg}`)
      if (!s.optional) break
    }
  }

  const text = [
    header(scenario, routeNote) + (targetNote ? `\ntarget: ${targetNote}` : ''),
    '',
    capSections(sections),
    '',
    `NEXT: ${scenario.next}`,
    `(steps: ${log.join(', ')} · session: ${session.describe()})`,
  ].join('\n')
  return images.length ? { text, images } : { text }
}

/**
 * Keep a routed answer within ~4k tokens (Claude Code warns at 10k): later
 * sections are trimmed first, and each trim names how to get the full output.
 */
const MAX_CHARS = 16_000
function capSections(sections: string[]): string {
  let total = sections.reduce((n, s) => n + s.length + 2, 0)
  const out = [...sections]
  for (let i = out.length - 1; i > 0 && total > MAX_CHARS; i--) {
    const sec = out[i]!
    const keep = Math.max(400, sec.length - (total - MAX_CHARS))
    if (keep >= sec.length) continue
    const tool = /^── (\S+)/.exec(sec)?.[1] ?? 'that tool'
    out[i] = `${sec.slice(0, keep)}\n… [trimmed ${sec.length - keep} chars — run solve({tool:"${tool}", args}) for the full output]`
    total -= sec.length - out[i]!.length
  }
  return out.join('\n\n')
}

function header(s: Scenario, note: string): string {
  return `solve → ${s.id}: ${s.title}${note ? `\n(${note})` : ''}`
}

function candidatesText(intent: string, candidates: Scenario[]): string {
  const list = (candidates.length ? candidates : SCENARIOS.slice(0, 8))
    .map((s) => `  - ${s.id}: ${s.title}`)
    .join('\n')
  return (
    `Could not map "${intent}" to a diagnostic with confidence. ${candidates.length ? 'Closest scenarios' : 'Common scenarios'}:\n${list}\n\n` +
    'Call solve again with scenario set to one of these (plus context.element), name the symptom more concretely ' +
    '(hidden / overlap / color / size / spacing / clipped / animation / click), or pick a tool directly with tool+args.'
  )
}

/** Run one plan step: a ToolDef call, or a solve-owned pseudo-step. */
async function runStep(
  session: SessionManager,
  ctx: ToolContext,
  s: PlanStep,
  target: Record<string, unknown> | undefined,
): Promise<ToolResult> {
  if (s.kind === 'viewport') {
    const { width, height } = s.args as { width: number; height: number }
    await session.setViewport(width, height)
    return { text: `viewport emulated at ${width}×${height}` }
  }
  if (s.kind === 'sweep') return responsiveSweep(session, ctx, target ?? {}, s.args as { breakpoints: number[]; property?: string })
  const def = TOOL_HANDLERS[s.tool]
  if (!def) throw new Error(`internal: unknown tool ${s.tool}`)
  return def.handler(ctx, s.args)
}

/**
 * In the user's own browser (extension mode) the page is logged in as THEM. A prompt-injected
 * agent must not get a script runner there, nor CSS that can phone home (attribute-selector
 * exfiltration via url()). Opt back in with VISIONAIRE_EXTENSION_EVALUATE=1.
 */
export function extensionModeRefusal(session: SessionManager, tool: string, args: Record<string, unknown>): string | undefined {
  if (session.currentMode !== 'extension' || process.env['VISIONAIRE_EXTENSION_EVALUATE'] === '1') return undefined
  if (tool === 'evaluate') {
    return (
      'evaluate is disabled in extension mode: it would run agent-written JavaScript inside the user\'s logged-in tab. ' +
      'Use the purpose-built tools, connect with mode "launch" for a scratch browser, or have the user set ' +
      'VISIONAIRE_EXTENSION_EVALUATE=1 in the MCP server env.'
    )
  }
  if (tool === 'inject_css') {
    const css = JSON.stringify([args['css'] ?? '', args['declarations'] ?? {}])
    if (/url\s*\(|@import|image-set\s*\(|src\s*\(/i.test(css)) {
      return 'inject_css in extension mode refuses url()/@import/image-set(): injected CSS must not load resources from the user\'s logged-in tab. Trial the fix without them.'
    }
  }
  return undefined
}

/** Expert mode: validate args against the tool's own schema, then run it. */
async function runDirect(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const def = TOOL_HANDLERS[name]!
  const check = z.object(def.inputSchema).strict().safeParse(args)
  if (!check.success) {
    return {
      text:
        `Invalid args for ${name}: ${check.error.issues.map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; ')}\n` +
        `${name} accepts: ${Object.keys(def.inputSchema).join(', ')}\n${def.description}`,
    }
  }
  const res = await def.handler(ctx, check.data)
  return { ...res, text: `solve → tool ${name}\n\n${res.text}` }
}

/** Measure the target at several widths, then restore the viewport. */
async function responsiveSweep(
  session: SessionManager,
  ctx: ToolContext,
  target: Record<string, unknown>,
  args: { breakpoints: number[]; property?: string },
): Promise<ToolResult> {
  const before = ctx.page.viewport()
  const height = before?.height ?? (await ctx.page.evaluate(() => window.innerHeight))
  const out: string[] = []
  try {
    for (const width of args.breakpoints.slice(0, 6)) {
      await session.setViewport(width, height)
      const lines: string[] = [`@ ${width}px`]
      try {
        const m = await measureElementTool.handler(ctx, target)
        lines.push(m.text.split('\n').slice(0, 4).join('\n'))
        if (args.property) {
          const e = await explainStylesTool.handler(ctx, { ...target, property: args.property })
          lines.push(e.text.split('\n').slice(0, 8).join('\n'))
        }
      } catch (err) {
        lines.push(`  ✗ ${err instanceof Error ? err.message : String(err)}`)
      }
      out.push(lines.join('\n'))
    }
  } finally {
    if (before) await session.setViewport(before.width, before.height, before.deviceScaleFactor)
    else await ctx.cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {})
  }
  return { text: out.join('\n\n') + '\n(viewport restored)' }
}

// ───────────────────────── element resolution ─────────────────────────

const HTML_TAGS = new Set([
  'a', 'button', 'nav', 'header', 'footer', 'main', 'section', 'article', 'aside', 'form', 'input', 'select',
  'textarea', 'label', 'img', 'video', 'ul', 'ol', 'li', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p',
  'span', 'div', 'body', 'html', 'dialog', 'svg', 'canvas', 'iframe', 'figure', 'picture',
])
const ROLE_WORDS: Record<string, string> = {
  button: 'button', btn: 'button', cta: 'button', link: 'link', heading: 'heading', title: 'heading',
  image: 'img', logo: 'img', input: 'textbox', field: 'textbox', checkbox: 'checkbox', menu: 'navigation', nav: 'navigation',
}

export function classifyElementRef(ref: string): { kind: 'uid' | 'selector' | 'text'; value: string } {
  const v = ref.trim()
  if (/^[ef]\d+$/.test(v)) return { kind: 'uid', value: v }
  if (/[.#[\]>:=*]/.test(v) && !/\s{2,}/.test(v) && !/^[A-Z][a-z]+ /.test(v)) return { kind: 'selector', value: v }
  if (HTML_TAGS.has(v.toLowerCase())) return { kind: 'selector', value: v.toLowerCase() }
  return { kind: 'text', value: v.replace(/^(the|a|an)\s+/i, '').replace(/^["']|["']$/g, '') }
}

async function resolveElement(
  ctx: ToolContext,
  ref: string,
): Promise<{ target: Record<string, unknown>; note: string } | { error: string }> {
  const c = classifyElementRef(ref)
  if (c.kind === 'uid') return { target: { uid: c.value }, note: c.value }
  if (c.kind === 'selector') return { target: { selector: c.value }, note: `selector ${c.value}` }
  // Text description → find_elements. Try "text + role" ("Subscribe button"), then text alone.
  const words = c.value.split(/\s+/)
  const last = words[words.length - 1]!.toLowerCase()
  const role = ROLE_WORDS[last]
  const attempts: Array<Record<string, unknown>> = []
  if (role && words.length > 1) attempts.push({ text: words.slice(0, -1).join(' '), role, visibleOnly: true, limit: 5 })
  attempts.push({ text: role && words.length > 1 ? words.slice(0, -1).join(' ') : c.value, visibleOnly: true, limit: 5 })
  for (const a of attempts) {
    const res = await findElementsTool.handler(ctx, a).catch(() => undefined)
    const uids = res ? [...new Set(res.text.match(/\be\d+\b/g) ?? [])] : []
    if (uids.length) {
      const extra = uids.length > 1 ? ` (first of ${uids.length} matches: ${uids.slice(0, 5).join(', ')} — pass a uid to pick another)` : ''
      return { target: { uid: uids[0] }, note: `${uids[0]} — found by text "${c.value}"${extra}` }
    }
  }
  return {
    error:
      `No visible element matches "${c.value}". Pass a uid from a snapshot, a CSS selector, or different visible text ` +
      '(solve({intent:"page overview", scenario:"page-overview"}) lists elements with uids).',
  }
}

// ───────────────────────── lite (Firefox) ─────────────────────────

/** Default properties per scenario for the CSSOM explainer (CDP plans use the full engine instead). */
const LITE_PROPS: Record<string, string[] | undefined> = {
  'element-wrong-size': ['width', 'height', 'min-width', 'max-width', 'min-height', 'max-height', 'flex-basis', 'box-sizing'],
  'spacing-wrong': ['margin', 'padding', 'gap'],
  'alignment-off': ['display', 'justify-content', 'align-items', 'align-self', 'text-align', 'margin', 'vertical-align'],
  'flex-grid-layout': ['display', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'gap', 'grid-template-columns', 'flex'],
  'element-hidden': ['display', 'visibility', 'opacity', 'height', 'width', 'overflow', 'z-index', 'position'],
  'overlap-z-index': ['z-index', 'position', 'opacity', 'transform', 'isolation'],
  'clipped-cutoff': ['overflow', 'width', 'height', 'max-width', 'max-height', 'white-space'],
  'text-truncated': ['white-space', 'overflow', 'text-overflow', 'width', 'max-width', '-webkit-line-clamp'],
  'font-wrong': ['font', 'letter-spacing'],
  'positioned-wrong': ['position', 'top', 'right', 'bottom', 'left', 'transform', 'margin'],
  'diagnose-issue': ['display', 'visibility', 'opacity', 'position', 'z-index', 'overflow', 'width', 'height'],
  'click-not-working': ['pointer-events', 'z-index', 'position', 'visibility', 'cursor'],
  'responsive-broken': ['display', 'width', 'max-width', 'flex-direction', 'grid-template-columns'],
}

async function liteResolve(lite: LiteSession, ref: string): Promise<{ target: LiteTarget; note: string } | { error: string }> {
  const c = classifyElementRef(ref)
  if (c.kind === 'uid') return { target: { uid: c.value }, note: c.value }
  if (c.kind === 'selector') return { target: { selector: c.value }, note: `selector ${c.value}` }
  const words = c.value.split(/\s+/)
  const role = ROLE_WORDS[words[words.length - 1]!.toLowerCase()]
  const text = role && words.length > 1 ? words.slice(0, -1).join(' ') : c.value
  const tries = role ? [{ text, role }, { text }] : [{ text }]
  for (const a of tries) {
    const { first } = await lite.find({ ...a, limit: 5 })
    if (first) return { target: { uid: first.uid }, note: `${first.uid} — found by text "${c.value}"` }
  }
  return { error: `No element matches "${c.value}". Use scenario "page-overview" for uids, or pass a selector.` }
}

async function liteSolve(lite: LiteSession, input: SolveInput): Promise<ToolResult> {
  const c: Ctx = input.context ?? {}
  if (c.viewport) {
    return { text: 'Viewport emulation needs the DevTools Protocol, which Firefox does not give extensions. Resize the window manually, or connect via Chrome.' }
  }
  const resolveIfAny = async (): Promise<{ target: LiteTarget; note: string } | { error: string } | undefined> =>
    c.element ? liteResolve(lite, c.element) : undefined

  if (input.tool) {
    const a = (input.args ?? {}) as Record<string, unknown>
    const tgt: LiteTarget = { uid: a['uid'] as string | undefined, selector: a['selector'] as string | undefined, x: a['x'] as number | undefined, y: a['y'] as number | undefined }
    switch (input.tool) {
      case 'page_snapshot':
        return lite.snapshot(Math.round(((a['budgetTokens'] as number) || 1500) / 6))
      case 'find_elements':
        return (await lite.find(a as { text?: string; role?: string; selector?: string })).result
      case 'explain_styles':
      case 'inspect_element':
      case 'measure_element':
      case 'diagnose':
      case 'inspect_ancestors':
        return lite.explain(tgt, a['property'] ? [String(a['property'])] : undefined)
      case 'node_at_point':
        return lite.hitTest(Number(a['x']), Number(a['y']))
      case 'explain_animations':
        return lite.animations(tgt.uid || tgt.selector ? tgt : undefined)
      case 'annotated_screenshot':
      case 'capture_proof':
        return lite.screenshot()
      default:
        return { text: `${input.tool} needs the DevTools Protocol and is unavailable in Firefox (lite). Available here: page_snapshot, find_elements, explain_styles, node_at_point, explain_animations, annotated_screenshot. Connect via Chrome for everything.` }
    }
  }

  const route = input.scenario ? undefined : routeQuery(input.intent)
  const scenario = input.scenario ? getScenario(input.scenario) : route?.best && route.best.score >= 3 ? route.best.scenario : c.element ? getScenario('diagnose-issue') : undefined
  if (!scenario) return { text: candidatesText(input.intent, route?.candidates.map((x) => x.scenario) ?? []) }

  const head = `solve → ${scenario.id}: ${scenario.title} (lite)`
  if (scenario.id === 'page-overview') return lite.snapshot()
  if (scenario.id === 'find-element') {
    const plan = scenario.plan({ intent: input.intent, selector: c.elements })
    return (await lite.find(plan[0]!.args as { text?: string; selector?: string })).result
  }
  const resolved = await resolveIfAny()
  if (resolved && 'error' in resolved) return { text: `${head}\n\n${resolved.error}` }
  if (scenario.id === 'animation-broken') {
    const res = await lite.animations(resolved?.target)
    // record_interaction needs CDP — in Firefox the user triggers the state change by hand.
    const next = 'transitions only exist mid-change — ask the user to hover/click the element, then re-run this while it animates.'
    return { ...res, text: `${head}${resolved ? `\ntarget: ${resolved.note}` : ''}\n\n${res.text}\n\nNEXT: ${next}` }
  }
  if (!resolved) {
    const snap = await lite.snapshot(150)
    return { text: `${head}\n\nNEED: ${scenario.ask ?? 'Which element?'} Call solve again with context.element = a uid below.\n\n${snap.text}` }
  }
  if (scenario.id === 'hover-state-wrong') {
    return { text: `${head}\n\nHover/focus states need input emulation (DevTools Protocol) — unavailable in Firefox. Connect via Chrome, or ask the user to hover while you call explain_styles via tool mode.` }
  }
  const explicit = c.property ?? inferProperty(input.intent)
  const props = explicit ? [explicit, ...(LITE_PROPS[scenario.id] ?? []).filter((p) => p !== explicit)] : LITE_PROPS[scenario.id]
  const res = await lite.explain(resolved.target, props)
  const extra = scenario.id === 'click-not-working' ? '\nNOTE event listeners cannot be listed from a Firefox extension; the coverage/pointer-events facts above are what lite mode can prove.' : ''
  return { text: `${head}\ntarget: ${resolved.note}\n\n${res.text}${extra}\n\nNEXT: ${scenario.next}` }
}
