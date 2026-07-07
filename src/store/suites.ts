/**
 * Assertion-suite store — the anti-gaslighting regression net (v-next SPEC §3A).
 * A suite is a named, viewport-agnostic array of assertion descriptors that
 * assert_visual / responsive_sweep re-run against the CURRENT render.
 *
 * Storage: in-memory map (like style_diff slots) with write-through JSON files
 * under $VISIONAIRE_SUITE_DIR (default <cwd>/.visionaire/suites) so suites
 * survive server restarts — the harness re-runs them across many turns.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { AssertionSpec } from '../engine/assert.js'
import { safeStorageId } from './artifacts.js'

const cache = new Map<string, AssertionSpec[]>()

function suiteDir(): string {
  return process.env['VISIONAIRE_SUITE_DIR'] || path.join(process.cwd(), '.visionaire', 'suites')
}

function suiteFile(id: string): string {
  return path.join(suiteDir(), `${id}.json`)
}

export function saveSuite(id: string, assertions: AssertionSpec[]): void {
  safeStorageId(id, 'suite_id')
  cache.set(id, assertions)
  try {
    fs.mkdirSync(suiteDir(), { recursive: true })
    fs.writeFileSync(suiteFile(id), JSON.stringify({ suite_id: id, assertions }, null, 2))
  } catch (err) {
    // Read-only cwd: the in-memory suite still works for this server's lifetime.
    console.error(`[visionaire] could not persist suite '${id}' to disk:`, err instanceof Error ? err.message : err)
  }
}

export function loadSuite(id: string): AssertionSpec[] | undefined {
  safeStorageId(id, 'suite_id')
  const hit = cache.get(id)
  if (hit) return hit
  try {
    const raw = JSON.parse(fs.readFileSync(suiteFile(id), 'utf8')) as { assertions?: AssertionSpec[] }
    if (Array.isArray(raw.assertions)) {
      cache.set(id, raw.assertions)
      return raw.assertions
    }
  } catch {
    // Missing or unreadable file — not registered.
  }
  return undefined
}

export function listSuites(): string[] {
  const ids = new Set(cache.keys())
  try {
    for (const f of fs.readdirSync(suiteDir())) {
      if (f.endsWith('.json')) ids.add(f.slice(0, -5))
    }
  } catch {
    // No suite dir yet.
  }
  return [...ids].sort()
}
