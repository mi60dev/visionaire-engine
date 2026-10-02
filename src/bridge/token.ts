/**
 * Shared pairing token for the extension bridge. One token per user account,
 * shared by every MCP server instance, so one pairing (a one-time code pasted
 * into the extension popup) pairs them all. Stored 0600 in ~/.visionaire/bridge-token
 * (override the directory with VISIONAIRE_HOME, used by tests).
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function visionaireHome(): string {
  return process.env['VISIONAIRE_HOME'] ?? path.join(os.homedir(), '.visionaire')
}

export function tokenPath(): string {
  return path.join(visionaireHome(), 'bridge-token')
}

/** Read the pairing token, creating it on first use (race-safe across concurrently starting servers). */
export function loadOrCreateToken(): string {
  const file = tokenPath()
  const read = (): string | undefined => {
    try {
      const existing = fs.readFileSync(file, 'utf8').trim()
      if (/^[0-9a-f]{32,}$/.test(existing)) {
        fs.chmodSync(file, 0o600) // repair a loosened mode
        return existing
      }
    } catch {
      // missing
    }
    return undefined
  }
  const existing = read()
  if (existing) return existing
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const token = randomBytes(24).toString('hex')
  try {
    // 'wx': exactly one of several servers starting at once creates it; the rest re-read.
    fs.writeFileSync(file, token + '\n', { mode: 0o600, flag: 'wx' })
    return token
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    for (let i = 0; i < 20; i++) {
      const again = read()
      if (again) return again
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25) // writer mid-write
    }
    throw new Error(`pairing key file ${file} exists but is unreadable or malformed — delete it and restart`)
  }
}

/** Rotate the token: every paired extension must be re-approved. */
export function resetToken(): string {
  try {
    fs.unlinkSync(tokenPath())
  } catch {
    // nothing to remove
  }
  return loadOrCreateToken()
}
