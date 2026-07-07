/**
 * Stop-gate + nudge hook scripts — pure Node tests (no Chrome). Installs the
 * harness into a temp cwd via initHarness, then drives the ACTUAL bash scripts
 * over stdin exactly like Claude Code does — including the grep fallback when
 * jq is absent from PATH.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initHarness } from '../src/harness-init.js'

const BASH = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash'

describe.skipIf(process.platform === 'win32')('harness hook scripts', () => {
  let tmp: string
  let prevCwd: string
  let gate: string
  let nudge: string
  let pending: string
  let verified: string

  beforeEach(async () => {
    prevCwd = process.cwd()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'visionaire-gate-'))
    process.chdir(tmp)
    await initHarness([])
    gate = path.join(tmp, '.claude', 'hooks', 'visionaire_gate.sh')
    nudge = path.join(tmp, '.claude', 'hooks', 'visionaire_nudge.sh')
    pending = path.join(tmp, '.claude', '.visionaire_pending')
    verified = path.join(tmp, '.claude', '.visionaire_verified')
  })

  afterEach(() => {
    process.chdir(prevCwd)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  /** Run a hook script the way Claude Code does: bash + event JSON on stdin. Throws on non-zero exit. */
  const runHook = (script: string, input: string, env?: NodeJS.ProcessEnv): string =>
    execFileSync(BASH, [script], { input, encoding: 'utf8', cwd: tmp, ...(env ? { env } : {}) })

  /**
   * A PATH containing ONLY the named binaries (symlinked from the system dirs)
   * — hides jq to force the scripts' grep fallback.
   */
  const stubPath = (names: string[]): string => {
    const stub = path.join(tmp, 'stub-bin')
    fs.mkdirSync(stub, { recursive: true })
    for (const name of names) {
      const real = ['/bin', '/usr/bin'].map((d) => path.join(d, name)).find((p) => fs.existsSync(p))
      if (!real) throw new Error(`no system binary found for ${name} in /bin or /usr/bin`)
      fs.symlinkSync(real, path.join(stub, name))
    }
    return stub
  }

  it('gate blocks the turn when pending is armed but no verification ran', () => {
    fs.writeFileSync(pending, '')
    const out = runHook(gate, '{}')
    expect(out).toContain('"decision":"block"')
    expect(out).toContain('assert_visual')
    // The marker stays armed so the retried turn is still gated.
    expect(fs.existsSync(pending)).toBe(true)
  })

  it('gate always lets a stop_hook_active retry pass (infinite-loop guard)', () => {
    fs.writeFileSync(pending, '')
    const out = runHook(gate, '{"stop_hook_active":true}')
    expect(out).toBe('')
    expect(fs.existsSync(pending)).toBe(true)
  })

  it('gate clears both markers when a verification pass is on record', () => {
    fs.writeFileSync(pending, '')
    fs.writeFileSync(verified, 'assert_visual\n')
    const out = runHook(gate, '{}')
    expect(out).toBe('')
    expect(fs.existsSync(pending)).toBe(false)
    expect(fs.existsSync(verified)).toBe(false)
  })

  it('gate is a silent no-op when no rendering file was edited', () => {
    const out = runHook(gate, '{}')
    expect(out).toBe('')
    expect(fs.existsSync(pending)).toBe(false)
    expect(fs.existsSync(verified)).toBe(false)
  })

  it('gate still blocks via the grep fallback when jq is not on PATH', () => {
    const stub = stubPath(['cat', 'grep', 'rm'])
    fs.writeFileSync(pending, '')
    const out = runHook(gate, '{}', { PATH: stub })
    expect(out).toContain('"decision":"block"')
    expect(fs.existsSync(pending)).toBe(true)
  })

  it('nudge arms the pending marker and reminds about assert_visual on a CSS edit', () => {
    const out = runHook(nudge, JSON.stringify({ tool_input: { file_path: 'x.css' } }))
    expect(out).toContain('assert_visual')
    expect(fs.existsSync(pending)).toBe(true)
  })

  it('nudge ignores non-rendering files', () => {
    const out = runHook(nudge, JSON.stringify({ tool_input: { file_path: 'x.py' } }))
    expect(out).toBe('')
    expect(fs.existsSync(pending)).toBe(false)
  })
})
