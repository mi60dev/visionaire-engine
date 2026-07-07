#!/usr/bin/env bash
# visionaire_nudge.sh — Claude Code PostToolUse hook (matcher: Edit|Write|MultiEdit).
#
# Reads the hook event JSON on stdin. When the edited file affects rendering
# (CSS/markup extensions) it:
#   1. arms the Stop gate by touching .claude/.visionaire_pending, and
#   2. injects a verification reminder into the transcript via additionalContext.
#
# Degrades gracefully when jq is missing (grep fallback, plain reminder without
# the file path). Always exits 0 — a nudge must never break the turn.
set -u

input=$(cat)

# Extract tool_input.file_path — jq when available, defensive grep fallback.
if command -v jq >/dev/null 2>&1; then
  file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
else
  file_path=$(printf '%s' "$input" |
    grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' |
    head -n 1 |
    sed 's/.*:[[:space:]]*"//; s/"$//')
fi

[ -z "${file_path:-}" ] && exit 0

case "$file_path" in
  *.css | *.scss | *.sass | *.less | *.jsx | *.tsx | *.vue | *.svelte | *.html)
    # Arm the Stop gate: this turn edited a rendering file.
    mkdir -p .claude && touch .claude/.visionaire_pending
    if command -v jq >/dev/null 2>&1; then
      jq -cn --arg fp "$file_path" \
        '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:("You edited a rendering file (" + $fp + "). Before claiming this works, run assert_visual (or the area suite) via the Visionaire MCP and report the measured verdict.")}}'
    else
      # No jq: the path cannot be safely JSON-escaped, so degrade to a plain reminder.
      printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"You edited a rendering file. Before claiming this works, run assert_visual (or the area suite) via the Visionaire MCP and report the measured verdict."}}'
    fi
    ;;
esac

exit 0
