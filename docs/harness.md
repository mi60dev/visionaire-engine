# The verify-after-edit harness

## What CSS gaslighting is

An agent edits a stylesheet, reads its own diff, and declares "now the cards are
equal height" — without ever seeing a rendered pixel. The user looks at the
browser, the cards are still ragged, and the agent doubles down because the
source "looks right". LLMs cannot see rendering; source code holds many
candidate rules but only the live cascade decides which one wins. The harness
in this directory closes that gap mechanically: after any edit to a rendering
file, the agent is nudged to verify against the live page, and the turn is
physically blocked from ending with an unverified "it's fixed" claim.

## Install

```sh
npx visionaire-engine init-harness
```

Run it from your project root. Flags:

- `--claude` — install only the Claude Code side (skill + hooks + settings)
- `--cursor` — install only the Cursor rule
- `--force` — overwrite existing harness files (never overwrites an existing
  `.claude/settings.json`; see below)

Without `--force`, existing files are reported as `exists, skipped (use --force)`
and left untouched.

## What gets installed

| Artifact | What it does |
| --- | --- |
| `.claude/skills/visionaire-verify/SKILL.md` | Teaches the agent the verify loop: preview blast radius, edit small, assert the claim, diagnose FAILs, sweep responsive, prove with a diff. Triggers on any visual edit, not just explicit "verify" requests. |
| `.claude/hooks/visionaire_nudge.sh` | PostToolUse hook (matcher `Edit\|Write\|MultiEdit`). When the edited file matches `*.css *.scss *.sass *.less *.jsx *.tsx *.vue *.svelte *.html`, it arms the Stop gate (`touch .claude/.visionaire_pending`) and injects a reminder into the transcript via `additionalContext`. |
| `.claude/hooks/visionaire_gate.sh` | Stop hook. Blocks the turn from ending when a rendering edit is pending without a verification pass; otherwise clears the markers. |
| `.claude/settings.json` | The hooks wiring. Created fresh only if absent — an existing `settings.json` is never modified; the snippet is printed for you to merge manually (also shipped as `harness/claude/settings.snippet.json` in the package). |
| `.cursor/rules/visionaire-verify.mdc` | The same loop as a Cursor rule, auto-attached via globs on the rendering-file extensions (`alwaysApply: false`). |

## Marker mechanics

Two zero-byte-ish marker files under `.claude/` carry the state, and the Stop gate reads them:

1. **`.claude/.visionaire_pending`** — touched by the nudge hook whenever an
   `Edit`/`Write`/`MultiEdit` targets a rendering file. Meaning: "this turn
   changed something visual".
2. **`.claude/.visionaire_verified`** — touched by the **MCP server itself**
   (`src/store/verify-marker.ts`) on every **successful** `assert_visual`,
   `visual_diff`, or `responsive_sweep` call. Running the check is what counts —
   a FAIL verdict is still a verification pass. The server only writes it when
   the `.claude` directory already exists, so projects without the harness are
   never touched.
3. **The Stop gate** (`visionaire_gate.sh`) evaluates at end of turn:
   - `stop_hook_active` in the hook input? → exit 0 immediately (mandatory
     infinite-loop guard).
   - `pending && !verified` → emit `{"decision":"block","reason":…}` telling
     the agent to run a verification and report the measured verdict.
   - otherwise → `rm -f` both markers and let the turn end. Each turn starts
     clean.

Both hooks prefer `jq` for parsing the hook JSON and degrade to a `grep`
fallback when `jq` is missing (the nudge then omits the file path from its
reminder rather than erroring).

## Env overrides

- **`VISIONAIRE_MARKER_DIR`** — where the MCP server writes
  `.visionaire_verified`. Default: `<cwd>/.claude` (only if that directory
  already exists). Set it when the server's working directory is not the
  project root (e.g. a globally configured MCP server), and point the hooks'
  project at the same place. The hooks themselves always use the project-local
  `.claude/` relative to where Claude Code runs them.

## Known Claude Code quirks (working as designed)

1. **A blocking Stop hook renders as "Stop hook error" in the UI** even when it
   is doing exactly its job. The agent still receives the `reason` text and
   continues the turn with a verification pass — the scary red label is
   cosmetic.
2. **Install the hooks in `.claude/hooks` directly, not via a plugin.** Plugin
   hook paths resolve against the plugin's own directory and the
   `${CLAUDE_PLUGIN_ROOT}` indirection has bitten these scripts before; plain
   project-local hooks are the reliable wiring.

## Cursor

The Cursor side is a single rule file installed at
`.cursor/rules/visionaire-verify.mdc`. Its globs auto-attach it whenever a
matching rendering file is in context; there are no hooks or markers on the
Cursor side — the rule carries the loop and the hard rules ("never claim a fix
without a PASS verdict") into the model's context.

## The verify loop (README-ready)

> ## The verify loop (stop the CSS gaslighting)
> Visionaire gives your agent deterministic eyes on rendered truth. The loop:
> 1. **Preview** shared-class blast radius → impact_preview.
> 2. **Edit** the smallest change.
> 3. **Assert** your claim → assert_visual (or re-run a named suite_id).
>    You get PASS/FAIL + the actual measured pixels + the offending element uids.
> 4. **Diagnose** any FAIL → diagnose returns the ranked culprit with evidence.
> 5. **Sweep** responsive → responsive_sweep returns a per-viewport verdict matrix.
> 6. **Prove** it → capture_proof bundles before/after screenshots + verdict delta.
>
> Wire the included Claude Code hooks (or Cursor rule) so the agent physically
> cannot end a turn claiming "it's fixed" without a PASS verdict on record.
