/**
 * Proof-bundle persistence (v-next SPEC §3G). A bundle is a named directory of
 * before/after evidence for one fix: <phase>.png (annotated screenshot) and
 * <phase>.verdicts.json (suite verdicts at capture time). capture_proof writes
 * a phase per call and, on 'after', diffs the stored 'before' verdicts.
 *
 * Location: artifactsDir('bundles', <bundle_id>) — bundle ids pass the same
 * strict allow-list as suite ids, so path traversal is impossible.
 */
import fs from 'node:fs'
import path from 'node:path'
import { artifactsDir, safeStorageId } from './artifacts.js'

export type BundlePhase = 'before' | 'after'

export function bundleDir(bundleId: string): string {
  return artifactsDir('bundles', safeStorageId(bundleId, 'bundle_id'))
}

export interface SavedPhase {
  imagePath?: string
  verdictsPath?: string
}

/** Write a phase's evidence files. Either part may be absent (e.g. no suite_id → no verdicts). */
export function savePhase(
  bundleId: string,
  phase: BundlePhase,
  png: Buffer | undefined,
  verdicts: object | undefined,
): SavedPhase {
  const dir = bundleDir(bundleId)
  const out: SavedPhase = {}
  try {
    if (png !== undefined) {
      const imagePath = path.join(dir, `${phase}.png`)
      fs.writeFileSync(imagePath, png)
      out.imagePath = imagePath
    }
    if (verdicts !== undefined) {
      const verdictsPath = path.join(dir, `${phase}.verdicts.json`)
      fs.writeFileSync(verdictsPath, JSON.stringify(verdicts, null, 2))
      out.verdictsPath = verdictsPath
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      `could not write ${phase} files for bundle '${bundleId}': ${msg} — check that $VISIONAIRE_ARTIFACTS_DIR is writable`,
    )
  }
  return out
}

export function loadPhaseVerdicts(bundleId: string, phase: BundlePhase): object | undefined {
  try {
    const raw = fs.readFileSync(path.join(bundleDir(bundleId), `${phase}.verdicts.json`), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as object) : undefined
  } catch {
    // Missing or unreadable — the phase was captured without verdicts (or not at all).
    return undefined
  }
}

/** True when the phase left ANY evidence behind (image or verdicts). */
export function hasPhase(bundleId: string, phase: BundlePhase): boolean {
  const dir = bundleDir(bundleId)
  return (
    fs.existsSync(path.join(dir, `${phase}.png`)) || fs.existsSync(path.join(dir, `${phase}.verdicts.json`))
  )
}
