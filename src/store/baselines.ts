/**
 * Pixel-baseline slots (v-next SPEC §3C / §4.1) — named PNG snapshots that
 * visual_diff compares the live render against. Recorded by style_diff
 * { mode: 'record', capture_pixels: true } (or any caller with a PNG buffer).
 *
 * Storage: <artifacts>/baselines/<slot>.png — slot names pass safeStorageId
 * (no dots, no separators), the filename is deterministic, and re-recording a
 * slot overwrites it in place.
 */
import fs from 'node:fs'
import path from 'node:path'
import { artifactsDir, safeStorageId } from './artifacts.js'

function baselineFile(slot: string): string {
  safeStorageId(slot, 'baseline_slot')
  return path.join(artifactsDir('baselines'), `${slot}.png`)
}

/** Persist a PNG under the slot (overwrites any previous recording). Returns the file path. */
export function saveBaselinePixels(slot: string, png: Buffer): string {
  const file = baselineFile(slot)
  fs.writeFileSync(file, png)
  return file
}

/** The slot's PNG bytes, or undefined when nothing has been recorded under it. */
export function loadBaselinePixels(slot: string): Buffer | undefined {
  try {
    return fs.readFileSync(baselineFile(slot))
  } catch (err) {
    // safeStorageId violations must surface; a missing file is just "empty slot".
    if (err instanceof Error && err.message.includes('baseline_slot')) throw err
    return undefined
  }
}
