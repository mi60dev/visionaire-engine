/**
 * Verification marker — the deterministic link between the MCP server and the
 * verify-after-edit harness (v-next SPEC §6b). The Stop hook blocks a turn that
 * edited a rendering file until a Visionaire verification tool has run; this
 * marker is how the hook knows one ran. Written on every SUCCESSFUL
 * assert_visual / visual_diff / responsive_sweep call (running the check is
 * what counts — a FAIL verdict is still a verification pass).
 *
 * Location: $VISIONAIRE_MARKER_DIR/.visionaire_verified when set, else
 * <cwd>/.claude/.visionaire_verified — and only when that .claude directory
 * already exists (we never create .claude in projects that don't use the
 * harness). Never throws: verification results must not fail on marker I/O.
 */
import fs from 'node:fs'
import path from 'node:path'

export function markVerified(toolName: string): void {
  try {
    const override = process.env['VISIONAIRE_MARKER_DIR']
    const dir = override || path.join(process.cwd(), '.claude')
    if (!override && !fs.existsSync(dir)) return
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.visionaire_verified'), `${toolName}\n`)
  } catch {
    // Marker is best-effort by design.
  }
}
