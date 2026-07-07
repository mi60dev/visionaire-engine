/**
 * markVerified default-path gating — pure Node tests. Without
 * VISIONAIRE_MARKER_DIR the marker lands in <cwd>/.claude, and ONLY when that
 * directory already exists: the marker must never create .claude in projects
 * that don't use the harness.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { markVerified } from '../src/store/verify-marker.js'

describe('markVerified default path', () => {
  let tmp: string
  let prevCwd: string
  let prevEnv: string | undefined

  beforeEach(() => {
    prevCwd = process.cwd()
    prevEnv = process.env['VISIONAIRE_MARKER_DIR']
    delete process.env['VISIONAIRE_MARKER_DIR']
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'visionaire-marker-'))
    process.chdir(tmp)
  })

  afterEach(() => {
    process.chdir(prevCwd)
    if (prevEnv !== undefined) process.env['VISIONAIRE_MARKER_DIR'] = prevEnv
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('writes nothing when the project has no .claude directory', () => {
    markVerified('x')
    expect(fs.existsSync(path.join(tmp, '.claude'))).toBe(false)
    expect(fs.readdirSync(tmp)).toEqual([])
  })

  it('writes the tool name into an existing .claude directory', () => {
    fs.mkdirSync(path.join(tmp, '.claude'))
    markVerified('assert_visual')
    const marker = path.join(tmp, '.claude', '.visionaire_verified')
    expect(fs.readFileSync(marker, 'utf8')).toBe('assert_visual\n')
  })
})
