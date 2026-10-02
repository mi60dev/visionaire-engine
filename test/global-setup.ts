/** Build the browser extension once per test run, from current sources, before any e2e file collects. */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export default function setup(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const r = spawnSync('npx', ['tsx', path.join(root, 'scripts', 'build-extension.ts')], { cwd: root, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`build:extension failed:\n${r.stderr}`)
}
