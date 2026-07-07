/**
 * initHarness — pure Node tests (no Chrome). Runs the installer into a temp
 * cwd and asserts: all four artifacts land, hooks are executable, settings.json
 * is created fresh from the snippet, re-runs without --force skip, an existing
 * settings.json is never modified, and --force overwrites.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initHarness } from '../src/harness-init.js'

const ARTIFACTS = [
  '.claude/skills/visionaire-verify/SKILL.md',
  '.claude/hooks/visionaire_nudge.sh',
  '.claude/hooks/visionaire_gate.sh',
  '.cursor/rules/visionaire-verify.mdc',
]

describe('initHarness', () => {
  let tmp: string
  let prevCwd: string

  beforeEach(() => {
    prevCwd = process.cwd()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'visionaire-harness-'))
    process.chdir(tmp)
  })

  afterEach(() => {
    process.chdir(prevCwd)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('installs all four artifacts plus a fresh settings.json', async () => {
    const code = await initHarness([])
    expect(code).toBe(0)
    for (const rel of ARTIFACTS) {
      expect(fs.existsSync(path.join(tmp, rel)), rel).toBe(true)
    }
    const settings = JSON.parse(fs.readFileSync(path.join(tmp, '.claude/settings.json'), 'utf8'))
    expect(settings.hooks.PostToolUse[0].matcher).toBe('Edit|Write|MultiEdit')
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe('.claude/hooks/visionaire_nudge.sh')
    expect(settings.hooks.PostToolUse[0].hooks[0].timeout).toBe(10)
    expect(settings.hooks.Stop[0].hooks[0].command).toBe('.claude/hooks/visionaire_gate.sh')
    expect(settings.hooks.Stop[0].hooks[0].timeout).toBe(30)
  })

  it('makes both hook scripts executable', async () => {
    await initHarness([])
    for (const rel of ['.claude/hooks/visionaire_nudge.sh', '.claude/hooks/visionaire_gate.sh']) {
      const mode = fs.statSync(path.join(tmp, rel)).mode
      expect(mode & 0o111, `${rel} should be executable`).not.toBe(0)
    }
  })

  it('skill and rule carry the expected content', async () => {
    await initHarness([])
    const skill = fs.readFileSync(path.join(tmp, '.claude/skills/visionaire-verify/SKILL.md'), 'utf8')
    expect(skill).toContain('name: visionaire-verify')
    expect(skill).toContain('## Hard rules')
    const rule = fs.readFileSync(path.join(tmp, '.cursor/rules/visionaire-verify.mdc'), 'utf8')
    expect(rule).toContain('alwaysApply: false')
    expect(rule).toContain('PASS verdict')
  })

  it('second run without --force skips: files keep local modifications', async () => {
    await initHarness([])
    const skillPath = path.join(tmp, '.claude/skills/visionaire-verify/SKILL.md')
    fs.writeFileSync(skillPath, 'LOCAL EDIT MARKER')
    const code = await initHarness([])
    expect(code).toBe(0)
    expect(fs.readFileSync(skillPath, 'utf8')).toBe('LOCAL EDIT MARKER')
  })

  it('--force overwrites modified artifacts', async () => {
    await initHarness([])
    const skillPath = path.join(tmp, '.claude/skills/visionaire-verify/SKILL.md')
    fs.writeFileSync(skillPath, 'LOCAL EDIT MARKER')
    const code = await initHarness(['--force'])
    expect(code).toBe(0)
    expect(fs.readFileSync(skillPath, 'utf8')).toContain('name: visionaire-verify')
  })

  it('never modifies an existing settings.json, even with --force', async () => {
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true })
    const settingsPath = path.join(tmp, '.claude/settings.json')
    const original = '{"permissions":{"allow":["Bash(ls:*)"]}}'
    fs.writeFileSync(settingsPath, original)
    expect(await initHarness([])).toBe(0)
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(original)
    expect(await initHarness(['--force'])).toBe(0)
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(original)
  })

  it('--claude installs only the Claude side', async () => {
    const code = await initHarness(['--claude'])
    expect(code).toBe(0)
    expect(fs.existsSync(path.join(tmp, '.claude/skills/visionaire-verify/SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(tmp, '.claude/settings.json'))).toBe(true)
    expect(fs.existsSync(path.join(tmp, '.cursor'))).toBe(false)
  })

  it('--cursor installs only the Cursor side', async () => {
    const code = await initHarness(['--cursor'])
    expect(code).toBe(0)
    expect(fs.existsSync(path.join(tmp, '.cursor/rules/visionaire-verify.mdc'))).toBe(true)
    expect(fs.existsSync(path.join(tmp, '.claude'))).toBe(false)
  })

  it('rejects unknown flags with exit code 1', async () => {
    expect(await initHarness(['--bogus'])).toBe(1)
    expect(fs.existsSync(path.join(tmp, '.claude'))).toBe(false)
  })
})
