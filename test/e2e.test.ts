/**
 * E2E against real Chrome — SPEC §12.2–12.3. Auto-skips when no Chrome is
 * installed. Drives the ToolDefs directly (handler(ctx, args)), not the MCP
 * transport.
 *
 * Fixture line-number contract (1-based as rendered in dossiers; CDP source
 * ranges are 0-based). LOAD-BEARING — keep in sync with test/fixtures/css/*:
 *
 *   css/theme.css:10   .hero-cta .btn { margin-bottom: 24px; }    cascade WINNER, spec (0,2,0)
 *   css/theme.css:12   .hero-cta .btn { color: #eeeeee; }         loses to the inline style attribute
 *   css/theme.css:14   .hero-cta .btn { width: 100%; }            INACTIVE — inline-level element
 *   css/theme.css:16   .hero-cta .btn { letter-spacing: 2px; }    loses to plugin.css !important
 *   css/theme.css:18   #promo-banner { … z-index: 9999; }         INACTIVE — position:static
 *   css/plugin.css:5   .btn { margin-bottom: 12px; }              loses on specificity, (0,1,0)
 *   css/plugin.css:7   .btn { letter-spacing: 1px !important; }   !important WINNER
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findChromeExecutable, SessionManager } from '../src/session.js'
import { explainStylesTool } from '../src/tools/explain-styles.js'
import { inspectElementTool } from '../src/tools/inspect-element.js'
import { pageOriginsTool } from '../src/tools/page-origins.js'
import { pageSnapshotTool } from '../src/tools/page-snapshot.js'
import { resolveTarget } from '../src/uid.js'

const THEME_MARGIN_BOTTOM_LINE = 10

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureUrl = (name: string): string => pathToFileURL(path.resolve(here, 'fixtures', name)).href

const chromePath = findChromeExecutable()

describe.skipIf(!chromePath)('e2e — real Chrome', () => {
  const session = new SessionManager()

  beforeAll(async () => {
    await session.connect({ mode: 'launch', headless: true })
  })

  afterAll(async () => {
    await session.disconnect()
  })

  /** First line of every dossier is "element eN <tag…>". */
  function uidFrom(dossierText: string): string {
    const m = /element (e\d+)\b/.exec(dossierText)
    expect(m, `no "element eN" identity line in:\n${dossierText}`).toBeTruthy()
    return m![1]!
  }

  async function inspect(selector: string): Promise<string> {
    const res = await inspectElementTool.handler(session.context(), { selector })
    return res.text
  }

  describe('cascade.html', () => {
    beforeAll(async () => {
      await session.navigate(fixtureUrl('cascade.html'))
    })

    it('page_snapshot returns uids and the button text', async () => {
      const res = await pageSnapshotTool.handler(session.context(), {})
      expect(res.text).toMatch(/\be\d+\b/)
      expect(res.text).toContain('Get started')
    })

    it('margin-bottom: theme.css:10 wins on specificity over plugin.css 12px', async () => {
      const res = await explainStylesTool.handler(session.context(), {
        selector: '.hero-cta .btn',
        property: 'margin-bottom',
      })
      expect(res.text).toContain('WINNER')
      expect(res.text).toContain('24px')
      expect(res.text).toMatch(new RegExp(`theme\\.css:${THEME_MARGIN_BOTTOM_LINE}\\b`))
      expect(res.text).toContain('lost (specificity)')
      expect(res.text).toContain('12px')
      expect(res.text).toContain('plugin.css')
    })

    it('letter-spacing: plugin !important beats the higher-specificity theme rule', async () => {
      const res = await explainStylesTool.handler(session.context(), {
        selector: '.hero-cta .btn',
        property: 'letter-spacing',
      })
      expect(res.text).toMatch(/WINNER[^\n]*1px/)
      expect(res.text).toContain('plugin.css')
      expect(res.text).toContain('2px')
    })

    it('color: the inline style attribute beats the theme rule', async () => {
      const res = await explainStylesTool.handler(session.context(), {
        selector: '.hero-cta .btn',
        property: 'color',
      })
      expect(res.text).toMatch(/WINNER[^\n]*inline/i)
      // Accept the authored value or its normalized rgb() form.
      expect(res.text).toMatch(/lost \(inline\)[^\n]*(?:#eeeeee|rgb\(238, 238, 238\))/)
    })

    it('flags the inactive width:100% on the inline-level button', async () => {
      const res = await explainStylesTool.handler(session.context(), { selector: '.hero-cta .btn' })
      const line = res.text.split('\n').find((l) => /width/.test(l) && /inactive/i.test(l))
      expect(line, `no inactive-width note in:\n${res.text}`).toBeTruthy()
    })

    it('flags the ineffective z-index on the position:static banner', async () => {
      const res = await explainStylesTool.handler(session.context(), { selector: '#promo-banner' })
      const line = res.text.split('\n').find((l) => /z-index/.test(l) && /inactive/i.test(l))
      expect(line, `no inactive z-index note in:\n${res.text}`).toBeTruthy()
    })
  })

  describe('visibility.html', () => {
    beforeAll(async () => {
      await session.navigate(fixtureUrl('visibility.html'))
    })

    it('reports a plainly visible element as visible', async () => {
      expect(await inspect('#normal')).toContain('visible')
    })

    it('reports display-none on self', async () => {
      expect(await inspect('#dn-self')).toContain('display-none')
    })

    it('reports display-none via ancestor, naming the ancestor uid', async () => {
      const ancestorUid = uidFrom(await inspect('#dn-ancestor'))
      const childText = await inspect('#dn-child')
      expect(childText).toContain('display-none')
      expect(childText).toContain(ancestorUid)
    })

    it('reports visibility-hidden', async () => {
      expect(await inspect('#vh')).toContain('visibility-hidden')
    })

    it('reports zero-size', async () => {
      expect(await inspect('#zero')).toContain('zero-size')
    })

    it('reports opacity-zero', async () => {
      expect(await inspect('#op0')).toContain('opacity-zero')
    })

    it('reports off-viewport for left:-9999px', async () => {
      expect(await inspect('#off-left')).toContain('off-viewport')
    })

    it('reports off-viewport for top:5000px', async () => {
      expect(await inspect('#off-down')).toContain('off-viewport')
    })

    it('reports occlusion, naming the overlay uid', async () => {
      const overlayUid = uidFrom(await inspect('#overlay'))
      const coveredText = await inspect('#covered')
      expect(coveredText).toContain('occluded')
      expect(coveredText).toContain(overlayUid)
    })
  })

  describe('wordpress.html', () => {
    beforeAll(async () => {
      await session.navigate(fixtureUrl('wordpress.html'))
    })

    it('page_origins detects the platform and classifies every sheet', async () => {
      const res = await pageOriginsTool.handler(session.context(), {})
      expect(res.text).toContain('WordPress')
      expect(res.text).toContain('6.9')
      expect(res.text).toContain('theme: astra')
      expect(res.text).toContain('plugin: myplugin')
      expect(res.text).toContain('[db-entity | Customizer')
      // Not an optimizer bundle: generated/db-entity label with no bypass hint.
      expect(res.text).toMatch(/\[(?:generated|db-entity) \| Elementor \(post 88\)/)
      expect(res.text).not.toMatch(/nowprocket|ao_noptimize/)
      expect(res.text).toMatch(/builders?:[^\n]*elementor/)
    })

    it('explain_styles attributes the elementor declaration to widget 4f2a1c', async () => {
      const res = await explainStylesTool.handler(session.context(), {
        selector: '.elementor-element-4f2a1c',
        property: 'margin-bottom',
      })
      expect(res.text).toMatch(/WINNER[^\n]*30px/)
      expect(res.text).toMatch(/widget 4f2a1c/)
      expect(res.text).toContain('88')
      // The theme's .elementor-widget rule (equal specificity, earlier sheet) lost.
      expect(res.text).toContain('20px')
    })
  })

  describe('CDP contract smoke (SPEC §10)', () => {
    beforeAll(async () => {
      await session.navigate(fixtureUrl('cascade.html'))
    })

    it('getMatchedStylesForNode carries the fields the engines depend on', async () => {
      const ctx = session.context()
      const node = await resolveTarget(ctx, { selector: '.hero-cta .btn' })
      const res = await ctx.cdp.send('CSS.getMatchedStylesForNode', { nodeId: node.nodeId })

      expect(res.matchedCSSRules).toBeDefined()
      const author = (res.matchedCSSRules ?? []).filter((m) => m.rule.origin === 'regular')
      expect(author.length).toBeGreaterThan(0)

      for (const m of author) {
        expect(Array.isArray(m.matchingSelectors)).toBe(true)
        expect(m.rule.selectorList).toBeDefined()
        expect(m.rule.selectorList.selectors.length).toBeGreaterThan(0)
        expect(typeof m.rule.selectorList.selectors[0]!.text).toBe('string')
        expect(Array.isArray(m.rule.style.cssProperties)).toBe(true)
      }

      // The 3-hop join (SPEC §7.2) needs per-declaration ranges + styleSheetId.
      const marginMatch = author.find(
        (m) =>
          m.rule.selectorList.selectors.some((s) => s.text === '.hero-cta .btn') &&
          m.rule.style.cssProperties.some((p) => p.name === 'margin-bottom'),
      )
      expect(marginMatch).toBeDefined()
      expect(marginMatch!.rule.styleSheetId).toBeDefined()
      const decl = marginMatch!.rule.style.cssProperties.find((p) => p.name === 'margin-bottom')!
      expect(decl.range).toBeDefined()
      // CDP ranges are 0-based; the fixture declaration sits on 1-based line 10.
      expect(decl.range!.startLine).toBe(THEME_MARGIN_BOTTOM_LINE - 1)

      // Cascade step (b) needs the inline style block (the fixture button has one).
      expect(res.inlineStyle).toBeDefined()
      expect(res.inlineStyle!.cssProperties.some((p) => p.name === 'color')).toBe(true)

      // Experimental fields — log presence, never fail (SPEC §9 feature detection).
      const hasSpecificity = author.some((m) =>
        m.rule.selectorList.selectors.some((s) => s.specificity !== undefined),
      )
      const hasLayers = author.some((m) => m.rule.layers !== undefined)
      console.log(
        `[cdp-contract] selector.specificity (experimental): ${
          hasSpecificity ? 'present' : 'ABSENT — engine must fall back to its own parser'
        }`,
      )
      console.log(
        `[cdp-contract] rule.layers (experimental): ${
          hasLayers ? 'present' : 'ABSENT — theme.css has an @layer rule matching this node'
        }`,
      )
    })
  })
})
