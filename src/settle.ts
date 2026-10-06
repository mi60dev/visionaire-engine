/**
 * Post-navigation settle for single-page apps. `load` fires long before an SPA has
 * fetched its data and rendered the route (field report 2026-10-06: navigate returned
 * while the page still read "Loading...", and the first screenshot showed only that).
 *
 * Settled = network quiet (no request in flight for NETWORK_IDLE_MS) AND DOM quiet
 * (no mutation for DOM_QUIET_MS), or the caller's selector is present — whichever the
 * caller asked for — bounded by a hard cap so navigate never waits forever.
 */
import type { Page } from 'puppeteer-core'

const NETWORK_IDLE_MS = 500
const DOM_QUIET_MS = 400
export const DEFAULT_SETTLE_MS = 8_000
export const MAX_SETTLE_MS = 30_000

export interface SettleResult {
  /** True when the page went quiet (or the selector appeared) within the cap. */
  settled: boolean
  /** Wall time spent waiting after `load`. */
  waitedMs: number
  /** One line for the tool output. */
  note: string
}

export function clampSettle(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms)) return DEFAULT_SETTLE_MS
  return Math.min(MAX_SETTLE_MS, Math.max(0, Math.round(ms)))
}

/**
 * In-page: resolves true once no DOM mutation happened for quietMs AND no loading indicator
 * is visible (aria-busy, a visible progressbar, or a short leaf reading "Loading…"/"Please
 * wait"); false at the deadline. A route that shows "Loading..." and renders on a timer is
 * DOM-quiet while it waits — the indicator check is what catches it.
 */
const DOM_QUIET_FN = `(quietMs, capMs) => new Promise((resolve) => {
  const LOADING = /^\\s*(loading|please wait|fetching)\\b[\\s\\S]{0,24}$/i
  const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
  const busy = () => {
    for (const el of document.querySelectorAll('[aria-busy="true"],[role="progressbar"]')) if (shown(el)) return true
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT)
    let n = 0
    for (let t = walker.nextNode(); t && n < 5000; t = walker.nextNode(), n++) {
      if (LOADING.test(t.data) && t.parentElement && shown(t.parentElement)) return true
    }
    return false
  }
  let last = Date.now()
  const obs = new MutationObserver(() => { last = Date.now() })
  obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
  const start = Date.now()
  const tick = setInterval(() => {
    const now = Date.now()
    if (now - last >= quietMs && !busy()) { clearInterval(tick); obs.disconnect(); resolve(true) }
    else if (now - start >= capMs) { clearInterval(tick); obs.disconnect(); resolve(false) }
  }, 100)
})`

export async function settlePage(page: Page, opts: { timeoutMs?: number; selector?: string } = {}): Promise<SettleResult> {
  const capMs = clampSettle(opts.timeoutMs)
  const t0 = Date.now()
  if (capMs === 0) return { settled: true, waitedMs: 0, note: 'settle: skipped (settleMs 0)' }

  if (opts.selector) {
    try {
      await page.waitForSelector(opts.selector, { timeout: capMs })
      const waitedMs = Date.now() - t0
      return { settled: true, waitedMs, note: `settle: "${opts.selector}" appeared after ${waitedMs}ms` }
    } catch {
      const waitedMs = Date.now() - t0
      return {
        settled: false,
        waitedMs,
        note: `settle: "${opts.selector}" did NOT appear within ${capMs}ms — the route may still be loading or the selector is wrong`,
      }
    }
  }

  const network = page
    .waitForNetworkIdle({ idleTime: NETWORK_IDLE_MS, timeout: capMs })
    .then(() => true)
    .catch(() => false)
  const dom = page
    .evaluate(`(${DOM_QUIET_FN})(${DOM_QUIET_MS}, ${capMs})`)
    .then((v) => v === true)
    .catch(() => false)
  const [netQuiet, domQuiet] = await Promise.all([network, dom])
  const waitedMs = Date.now() - t0
  if (netQuiet && domQuiet) return { settled: true, waitedMs, note: `settle: network and DOM quiet after ${waitedMs}ms` }
  const busy = [!netQuiet && 'network requests', !domQuiet && 'DOM changes or a loading indicator'].filter(Boolean).join(' and ')
  return {
    settled: false,
    waitedMs,
    note:
      `settle: ${busy} still going after ${capMs}ms — the page may not be fully rendered ` +
      '(pass waitFor:"<selector of the content you expect>" or a larger settleMs)',
  }
}
