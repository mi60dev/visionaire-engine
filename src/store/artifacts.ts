/**
 * Artifacts directory — where v-next tools write images (diff heatmaps, proof
 * screenshots) and bundles. MCP responses return FILE PATHS, never base64, so
 * large images can never blow the client's token ceiling (v-next SPEC §3, §7).
 *
 * Location: $VISIONAIRE_ARTIFACTS_DIR, else <tmpdir>/visionaire-artifacts.
 * Names are deterministic per server process: <kind>_<NNNN>.<ext> from a
 * monotonic counter (no timestamps, no randomness — same session, same order,
 * same names).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let counter = 0

export function artifactsDir(...sub: string[]): string {
  const base = process.env['VISIONAIRE_ARTIFACTS_DIR'] || path.join(os.tmpdir(), 'visionaire-artifacts')
  const dir = path.join(base, ...sub)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Next deterministic artifact path, e.g. artifactPath('diff', 'png') → …/diff_0007.png */
export function artifactPath(kind: string, ext: string, ...sub: string[]): string {
  const safeKind = kind.replace(/[^a-z0-9-]/gi, '_')
  const name = `${safeKind}_${String(++counter).padStart(4, '0')}.${ext}`
  return path.join(artifactsDir(...sub), name)
}

/**
 * Validate a caller-supplied storage id (suite id, bundle id, baseline slot)
 * before it becomes part of a filesystem path. Strict allow-list — no dots, no
 * separators — so path traversal is impossible by construction.
 */
export function safeStorageId(id: string, what: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) {
    throw new Error(
      `Invalid ${what} "${id}" — use 1-64 characters: letters, digits, hyphens, underscores (must start alphanumeric).`,
    )
  }
  return id
}
