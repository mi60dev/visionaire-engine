/**
 * `visionaire-engine init-harness` — installs the verify-after-edit harness
 * (v-next SPEC §3B + §6) into the CURRENT working directory: a Claude Code
 * skill + hooks that stop "it's fixed" claims without a verification pass on
 * record, and a Cursor rule carrying the same loop.
 *
 * Non-destructive by design: never overwrites an existing file without
 * --force, and NEVER modifies an existing .claude/settings.json (prints the
 * hooks snippet to merge manually instead — even under --force). All output
 * goes to stderr: stdout is reserved for the MCP protocol, and init keeps
 * that invariant even though it runs standalone.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

interface HarnessFile {
  /** Source path relative to the harness template dir. */
  src: string
  /** Destination path relative to the current working directory. */
  dest: string
  executable: boolean
  side: 'claude' | 'cursor'
}

const HARNESS_FILES: HarnessFile[] = [
  {
    src: 'claude/skills/visionaire-verify/SKILL.md',
    dest: '.claude/skills/visionaire-verify/SKILL.md',
    executable: false,
    side: 'claude',
  },
  {
    src: 'claude/hooks/visionaire_nudge.sh',
    dest: '.claude/hooks/visionaire_nudge.sh',
    executable: true,
    side: 'claude',
  },
  {
    src: 'claude/hooks/visionaire_gate.sh',
    dest: '.claude/hooks/visionaire_gate.sh',
    executable: true,
    side: 'claude',
  },
  {
    src: 'cursor/rules/visionaire-verify.mdc',
    dest: '.cursor/rules/visionaire-verify.mdc',
    executable: false,
    side: 'cursor',
  },
]

const SETTINGS_SNIPPET_SRC = 'claude/settings.snippet.json'
const SETTINGS_DEST = path.join('.claude', 'settings.json')

/**
 * Template dir resolved relative to THIS module, so it works both from src/
 * (tsx during development) and dist/ (the published npm package): one level
 * up from the module, in harness/.
 */
function templateRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'harness')
}

function installFile(srcAbs: string, destRel: string, force: boolean, executable: boolean): void {
  if (fs.existsSync(destRel) && !force) {
    console.error(`  ${destRel}: exists, skipped (use --force)`)
    return
  }
  fs.mkdirSync(path.dirname(destRel), { recursive: true })
  fs.copyFileSync(srcAbs, destRel)
  if (executable) fs.chmodSync(destRel, 0o755)
  console.error(`  ${destRel}: installed`)
}

export async function initHarness(argv: string[]): Promise<number> {
  let claudeOnly = false
  let cursorOnly = false
  let force = false
  for (const arg of argv) {
    if (arg === '--claude') claudeOnly = true
    else if (arg === '--cursor') cursorOnly = true
    else if (arg === '--force') force = true
    else {
      console.error(`init-harness: unknown flag '${arg}' — supported: --claude, --cursor, --force`)
      return 1
    }
  }
  const both = claudeOnly === cursorOnly // neither or both flags → install both sides
  const installClaude = both || claudeOnly
  const installCursor = both || cursorOnly

  const root = templateRoot()
  if (!fs.existsSync(root)) {
    console.error(
      `init-harness: harness templates not found at ${root} — reinstall visionaire-engine (the package must ship a harness/ directory next to its code)`,
    )
    return 1
  }

  console.error(`visionaire-engine init-harness → ${process.cwd()}`)

  for (const file of HARNESS_FILES) {
    if (file.side === 'claude' && !installClaude) continue
    if (file.side === 'cursor' && !installCursor) continue
    installFile(path.join(root, file.src), file.dest, force, file.executable)
  }

  if (installClaude) {
    const snippetAbs = path.join(root, SETTINGS_SNIPPET_SRC)
    if (!fs.existsSync(SETTINGS_DEST)) {
      fs.mkdirSync(path.dirname(SETTINGS_DEST), { recursive: true })
      fs.copyFileSync(snippetAbs, SETTINGS_DEST)
      console.error(`  ${SETTINGS_DEST}: created with the Visionaire hooks config`)
    } else {
      console.error(`  ${SETTINGS_DEST}: exists — NOT modified (non-destructive by design).`)
      console.error('  Merge this "hooks" config into it manually:')
      console.error(fs.readFileSync(snippetAbs, 'utf8'))
    }
  }

  console.error('Done. See docs/harness.md for how the verify loop works.')
  return 0
}
