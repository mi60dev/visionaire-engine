/**
 * Shared contracts for visionaire-engine. Every module imports from here.
 * See SPEC.md §5 (data model) and §11 (module contracts).
 */
import type { CDPSession, Page, Protocol } from 'puppeteer-core'
import type { ZodRawShape } from 'zod'

// ───────────────────────── Element addressing ─────────────────────────

/** How a caller points at an element. Exactly one of: uid | selector | (x,y). */
export interface TargetSpec {
  uid?: string
  selector?: string
  x?: number
  y?: number
}

export interface UidEntry {
  uid: string
  backendNodeId: number
  tag?: string
  classes?: string[]
  attrId?: string
  textPreview?: string
}

/** A target resolved against the live page. nodeId is pushed-to-frontend, session-scoped. */
export interface ResolvedNode {
  uid: string
  backendNodeId: number
  nodeId: Protocol.DOM.NodeId
}

// ───────────────────────── Tool plumbing ─────────────────────────

export interface ToolImage {
  /** base64 */
  data: string
  mimeType: string
}

export interface ToolResult {
  text: string
  images?: ToolImage[]
}

export interface ToolContext {
  page: Page
  cdp: CDPSession
  uids: UidRegistryLike
  sheets: StylesheetRegistryLike
  /** JS attribution registry (SPEC §14.1); wired at connect. Optional so pre-v0.3 stubs compile — tools must error helpfully when absent. */
  scripts?: ScriptRegistryLike
}

/**
 * Every tool module exports one of these; server.ts registers them all.
 * inputSchema is a zod raw shape (the object passed to z.object()).
 */
export interface ToolDef {
  name: string
  description: string
  inputSchema: ZodRawShape
  handler: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>
}

export interface UidRegistryLike {
  /** Same backendNodeId always returns the same uid until clear(). */
  assign(backendNodeId: number, meta?: Partial<Omit<UidEntry, 'uid' | 'backendNodeId'>>): string
  get(uid: string): UidEntry | undefined
  byBackendId(backendNodeId: number): string | undefined
  clear(): void
}

// ───────────────────────── Stylesheets & attribution ─────────────────────────

/** Honesty ladder — SPEC §5.2. */
export type Granularity = 'line' | 'file' | 'db-entity' | 'component' | 'generated' | 'unknown'

export interface SheetInfo {
  styleSheetId: string
  sourceURL: string
  isInline: boolean
  origin: Protocol.CSS.StyleSheetOrigin
  sourceMapURL?: string
  /** DOM id="" attribute of the owning <style>/<link>, resolved lazily. WP handles live here. */
  ownerNodeAttrId?: string
  header: Protocol.CSS.CSSStyleSheetHeader
}

export interface StylesheetRegistryLike {
  /** Subscribe to CSS.styleSheetAdded; CSS.enable replays existing sheets. */
  attach(cdp: CDPSession): Promise<void>
  get(styleSheetId: string): SheetInfo | undefined
  all(): SheetInfo[]
  /** Classify a sheet (plus optional matching selector for builder-widget extraction) into an origin. */
  classify(sheet: SheetInfo, selector?: string): StyleOrigin
  /** Resolve ownerNodeAttrId for sheets that still lack it (SPEC §7.1 lazy owner-id resolution). */
  ensureOwnerIds(): Promise<void>
  clear(): void
}

export interface StyleOrigin {
  granularity: Granularity
  /** Human label, e.g. "theme: astra-child" or "Customizer > Additional CSS". */
  label: string
  /** Actionable edit pointer, e.g. "edit themes/astra-child/style.css:104" or "Elementor editor > Advanced > Padding". */
  editSurface?: string
  file?: string
  line?: number
  column?: number
  wp?: WpOrigin
}

// Rule-level attribution reports child themes as 'theme' (parent/child is a
// page-level distinction — detectPlatform); unresolved sheets return undefined
// from resolveWpOrigin and fall through to generic classification.
export type WpOriginKind =
  | 'theme'
  | 'plugin'
  | 'customizer-css'
  | 'global-styles'
  | 'block-library'
  | 'block-supports'
  | 'inline-handle'
  | 'elementor-post'
  | 'elementor-global'
  | 'divi-generated'
  | 'optimizer-bundle'

export interface WpOrigin {
  kind: WpOriginKind
  slug?: string
  handle?: string
  postId?: number
  widgetId?: string
  /** e.g. "?nowprocket" — re-inspect with this query param to bypass the optimizer. */
  bypassHint?: string
}

/** Input for the pure WP resolver — constructed from SheetInfo + page markers (testable without a browser). */
export interface WpSheetMeta {
  sourceURL: string
  ownerNodeAttrId?: string
  isInline: boolean
  /** A selector from the rule being attributed, for .elementor-element-{id} extraction. */
  selector?: string
}

export interface PlatformInfo {
  platform?: 'wordpress'
  version?: string
  theme?: string
  childTheme?: string
  builders: string[]
  optimizers: string[]
}

export interface AuthoredPos {
  file: string
  line: number
  column: number
}

// ───────────────────────── Cascade engine ─────────────────────────

export interface Specificity {
  a: number
  b: number
  c: number
}

export type DeclOriginType =
  | 'inline'
  | 'attribute'
  | 'matched'
  | 'inherited'
  | 'inherited-inline'
  | 'user-agent'
  | 'injected'

export interface DeclarationInfo {
  property: string
  value: string
  important: boolean
  originType: DeclOriginType
  selector?: string
  specificity?: Specificity
  layer?: string
  /** e.g. "(min-width: 768px)" when the winning rule sits in a media query. */
  media?: string
  styleSheetId?: string
  /** CDP SourceRange (0-based); render 1-based. */
  range?: Protocol.CSS.SourceRange
  inheritedFromBackendNodeId?: number
  /** Set when this longhand was expanded from a shorthand declaration. */
  fromShorthand?: string
}

export type LossReason =
  | 'importance'
  | 'specificity'
  | 'order'
  | 'layer'
  | 'origin'
  | 'inline'
  | 'inherited-distance'

export interface PropertyVerdict {
  property: string
  winner?: DeclarationInfo
  losers: Array<{ decl: DeclarationInfo; reason: LossReason }>
  computedValue?: string
  /** Set when the predicted winner's value disagrees with the computed value — SPEC §9. */
  uncertain?: boolean
}

export interface InactiveFinding {
  decl: DeclarationInfo
  reason: string
  fixHint?: string
}

// ───────────────────────── Visibility & layout engines ─────────────────────────

export type VisibilityStatus =
  | 'visible'
  | 'detached'
  | 'display-none'
  | 'visibility-hidden'
  | 'zero-size'
  | 'opacity-zero'
  | 'off-viewport'
  | 'clipped'
  | 'occluded'
  | 'transparent-text'

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export interface VisibilityReport {
  status: VisibilityStatus
  visible: boolean
  /** Human sentence, e.g. "ancestor e12 has display:none (set by .mobile-only at theme.css:88)". */
  cause?: string
  /** Ancestor or occluder uid, when applicable. */
  causeUid?: string
  bounds?: Bounds
}

export interface BoxSummary {
  content: Bounds
  padding: [number, number, number, number]
  border: [number, number, number, number]
  margin: [number, number, number, number]
}

export interface AncestorLine {
  uid: string
  tag: string
  classes: string[]
  attrId?: string
  /** Concern-relevant computed props, already condensed to a short string. */
  summary: string
  /** True when this ancestor is detected as the binding constraint. */
  binding?: boolean
}

// ───────────────────────── Snapshot / census ─────────────────────────

export interface SnapshotNode {
  uid: string
  backendNodeId: number
  tag: string
  classes: string[]
  attrId?: string
  role?: string
  text?: string
  bounds?: Bounds
  paintOrder?: number
  visible: boolean
  /** Reason string when invisible, e.g. "display:none". */
  invisibleReason?: string
  /** Condensed layout hints: "flex", "grid", "sticky z:100", "absolute". */
  layout?: string
  children: SnapshotNode[]
  /** Count of children dropped by pruning. */
  prunedChildren?: number
}

export interface PageMeta {
  url: string
  title: string
  viewport: { width: number; height: number }
  platform?: PlatformInfo
}

// ───────────────────────── Dossier rendering ─────────────────────────

export interface ElementSummary {
  uid: string
  tag: string
  classes: string[]
  attrId?: string
  text?: string
}

export interface AttributedDeclaration extends DeclarationInfo {
  origin?: StyleOrigin
  authored?: AuthoredPos
}

export interface AttributedVerdict {
  property: string
  winner?: AttributedDeclaration
  losers: Array<{ decl: AttributedDeclaration; reason: LossReason }>
  computedValue?: string
  uncertain?: boolean
}

export interface WhyDossierInput {
  element: ElementSummary
  visibility?: VisibilityReport
  verdicts: AttributedVerdict[]
  inactive?: InactiveFinding[]
  notes?: string[]
  /** Emitted when verdicts were truncated for budget. */
  truncatedProperties?: number
}

export interface WhatDossierInput {
  element: ElementSummary
  box?: BoxSummary
  visibility: VisibilityReport
  /** Property → "computed" or "computed → used" pair strings, already filtered to the whitelist. */
  computed: Array<{ property: string; value: string; usedValue?: string }>
  layout?: string
  notes?: string[]
}

// ───────────────────────── Shared constants ─────────────────────────

/** Whitelist of layout-affecting computed properties for Pass-1 snapshots and what-dossiers (SPEC §3). */
export const COMPUTED_WHITELIST = [
  'display', 'position', 'top', 'right', 'bottom', 'left', 'float', 'clear',
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'box-sizing', 'overflow-x', 'overflow-y', 'z-index', 'opacity', 'visibility',
  'transform', 'flex-direction', 'flex-grow', 'flex-shrink', 'flex-basis',
  'grid-template-columns', 'grid-template-rows', 'gap',
  'align-items', 'justify-content', 'align-self', 'justify-self',
  'font-size', 'font-family', 'font-weight', 'line-height', 'color',
  'background-color', 'text-align', 'white-space', 'pointer-events',
  'content-visibility', 'clip-path', 'filter', 'mix-blend-mode',
] as const

/** Rough token estimate used by all budgeted renderers. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// ───────────────────────── Time dimension (SPEC §14) ─────────────────────────

export interface ScriptInfo {
  scriptId: string
  url: string
  sourceMapURL?: string
  embedderName?: string
}

/** A script position resolved for humans: 1-based, source-mapped when possible, WP-labeled. */
export interface ResolvedScriptPos {
  url: string
  line: number
  column: number
  functionName?: string
  authored?: AuthoredPos
  /** Origin label via the WP lens, e.g. "plugin: some-slider" — empty for non-WP scripts. */
  originLabel?: string
}

export interface ScriptRegistryLike {
  /** Subscribe to Debugger.scriptParsed; session enables Debugger. Clears on navigation. */
  attach(cdp: CDPSession): Promise<void>
  get(scriptId: string): ScriptInfo | undefined
  /** CDP positions are 0-based; result is 1-based. Resolves JS source maps with caching. */
  resolvePosition(scriptId: string, line: number, column: number): Promise<ResolvedScriptPos | undefined>
  clear(): void
}

export interface ListenerInfo {
  eventType: string
  capture: boolean
  passive: boolean
  once: boolean
  location?: ResolvedScriptPos
  /** Set when the handler belongs to a known delegation framework (react-dom, jquery, vue). */
  delegatedBy?: string
  /** uid of the node carrying the listener ('document'/'window' as pseudo-uids for those targets). */
  ownerUid: string
}

/** One entry from the in-page element.getAnimations() census — SPEC §14.3. */
export interface AnimationCensusEntry {
  kind: 'CSSTransition' | 'CSSAnimation' | 'WebAnimation'
  /** transitionProperty for transitions, animationName for CSS animations, id/empty for WAAPI. */
  name: string
  playState: string
  currentTimeMs: number | null
  durationMs: number
  delayMs: number
  easing: string
  iterations: number | 'infinite'
  fill: string
  /** Longhand properties this animation touches (from getKeyframes). */
  properties: string[]
}

/** A finding from the closed "not smooth" ruleset (R1–R6) — SPEC §14.3. */
export interface AnimationFinding {
  rule: 'non-animatable' | 'auto-dimension' | 'main-thread' | 'no-transition' | 'reduced-motion' | 'raf-blindness'
  property?: string
  reason: string
  fixHint?: string
}

export type TimelineEventKind =
  | 'action'
  | 'handler'
  | 'attribute-change'
  | 'node-inserted'
  | 'node-removed'
  | 'text-change'
  | 'animation-started'
  | 'animation-cancelled'
  | 'layout-shift'
  | 'console-error'
  | 'exception'
  | 'coalesced'

/** One line of the record_interaction causal timeline — SPEC §14.4. */
export interface TimelineEvent {
  /** Milliseconds since the action, best-effort (CDP DOM events carry no timestamps — arrival order is authoritative). */
  tMs?: number
  kind: TimelineEventKind
  /** uid of the affected element when known. */
  uid?: string
  /** Human line fragment, e.g. "class +collapsed" or "width transition started (300ms ease)". */
  summary: string
  /** Source attribution when available. */
  source?: ResolvedScriptPos
  /** Honesty note when attribution is partial, e.g. "creation stacks cover insertions only". */
  attributionNote?: string
  /** For 'coalesced': how many similar events this line stands for. */
  count?: number
}
