/**
 * Unit tests for the cold-start Chrome discovery added after field report #5:
 * `connect` mode:"launch" failed with "No Chrome executable found" even though a
 * puppeteer-cached Chrome existed. findPuppeteerCachedChrome now scans that cache.
 *
 * Pure/unit: builds a fake `@puppeteer/browsers` cache layout in a temp dir — no
 * real Chrome required. The binary's relative path is platform-specific, mirroring
 * the resolver in session.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findPuppeteerCachedChrome, isSandboxBlocked } from '../src/session.js'

/** Relative path from a `<version>/<platform>` root to the binary, per OS. */
function relBinary(): string[] {
  if (process.platform === 'darwin') {
    return ['Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing']
  }
  if (process.platform === 'win32') return ['chrome.exe']
  return ['chrome']
}

/** Platform subdir name puppeteer would use — the resolver reads it back, so any value works. */
function platformDir(): string {
  if (process.platform === 'darwin') return 'chrome-mac-arm64'
  if (process.platform === 'win32') return 'chrome-win64'
  return 'chrome-linux64'
}

/** Create <base>/<version>/<platform>/<binary> and write a dummy executable. Returns the binary path. */
function writeFakeChrome(base: string, version: string): string {
  const root = path.join(base, version, platformDir())
  const binary = path.join(root, ...relBinary())
  fs.mkdirSync(path.dirname(binary), { recursive: true })
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n')
  return binary
}

describe('findPuppeteerCachedChrome', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'visionaire-ppt-cache-'))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('finds the binary in a single-version cache', () => {
    const binary = writeFakeChrome(tmp, 'mac_arm-131.0.6778.204')
    expect(findPuppeteerCachedChrome(tmp)).toBe(binary)
  })

  it('picks the newest version when several are installed', () => {
    // Write oldest last to prove ordering is by name, not insertion/readdir order.
    writeFakeChrome(tmp, 'mac_arm-132.0.6834.110')
    writeFakeChrome(tmp, 'mac_arm-131.0.6778.204')
    const newest = writeFakeChrome(tmp, 'mac_arm-133.0.7000.0')
    expect(findPuppeteerCachedChrome(tmp)).toBe(newest)
  })

  it('returns undefined for a missing base directory', () => {
    expect(findPuppeteerCachedChrome(path.join(tmp, 'does-not-exist'))).toBeUndefined()
  })

  it('returns undefined for an empty base directory', () => {
    expect(findPuppeteerCachedChrome(tmp)).toBeUndefined()
  })

  it('returns undefined when versioned dirs contain no chrome binary', () => {
    // A version dir with a platform subdir but no actual binary (e.g. interrupted install).
    fs.mkdirSync(path.join(tmp, 'mac_arm-131.0.6778.204', platformDir()), { recursive: true })
    expect(findPuppeteerCachedChrome(tmp)).toBeUndefined()
  })

  it('skips a version whose platform dir lacks the binary and falls to an older complete one', () => {
    const older = writeFakeChrome(tmp, 'mac_arm-131.0.6778.204')
    // Newer version present but incomplete (no binary) — must fall through, not return undefined.
    fs.mkdirSync(path.join(tmp, 'mac_arm-132.0.6834.110', platformDir()), { recursive: true })
    expect(findPuppeteerCachedChrome(tmp)).toBe(older)
  })

  it('ignores stray files sitting next to version dirs', () => {
    fs.writeFileSync(path.join(tmp, '.DS_Store'), 'junk')
    const binary = writeFakeChrome(tmp, 'mac_arm-131.0.6778.204')
    expect(findPuppeteerCachedChrome(tmp)).toBe(binary)
  })
})

describe('isSandboxBlocked (launch-failure classifier)', () => {
  it('matches classic sandbox messages', () => {
    expect(isSandboxBlocked('No usable sandbox! Update your kernel')).toBe(true)
    expect(isSandboxBlocked('The SUID sandbox helper binary was found, but is not configured correctly')).toBe(true)
    expect(isSandboxBlocked('Failed to move to new namespace')).toBe(true)
  })
  it('matches Ubuntu 24.04 AppArmor/userns shapes that never say "sandbox"', () => {
    expect(isSandboxBlocked('clone() failed: Operation not permitted')).toBe(true)
    expect(isSandboxBlocked('unshare(CLONE_NEWUSER): EPERM')).toBe(true)
  })
  it('does not match unrelated failures', () => {
    expect(isSandboxBlocked('error while loading shared libraries: libnss3.so')).toBe(false)
    expect(isSandboxBlocked('Failed to launch the browser process! Code: null')).toBe(false)
  })
})
