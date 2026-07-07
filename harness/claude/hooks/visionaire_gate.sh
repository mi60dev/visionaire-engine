#!/usr/bin/env bash
# visionaire_gate.sh — Claude Code Stop hook: the anti-gaslighting gate.
#
# Blocks the turn from ending when a rendering file was edited this turn
# (.claude/.visionaire_pending, armed by visionaire_nudge.sh) but no Visionaire
# verification pass ran (.claude/.visionaire_verified, written by the MCP
# server on every successful assert_visual / visual_diff / responsive_sweep).
# Otherwise clears both markers and lets the turn end.
#
# Degrades gracefully when jq is missing (grep fallback).
set -u

input=$(cat)

# MANDATORY infinite-loop guard, FIRST: when this hook already blocked once,
# Claude Code re-invokes it with stop_hook_active=true — always let that pass.
if command -v jq >/dev/null 2>&1; then
  active=$(printf '%s' "$input" | jq -r '.stop_hook_active // false' 2>/dev/null)
else
  active=false
  printf '%s' "$input" | grep -o '"stop_hook_active"[[:space:]]*:[[:space:]]*true' >/dev/null 2>&1 && active=true
fi
[ "${active:-false}" = "true" ] && exit 0

pending=.claude/.visionaire_pending
verified=.claude/.visionaire_verified

if [ -f "$pending" ] && [ ! -f "$verified" ]; then
  printf '%s\n' '{"decision":"block","reason":"You edited a rendering file this turn but have not run a Visionaire verification pass. Call assert_visual (or the relevant suite / responsive_sweep) and confirm a PASS verdict before finishing. Do not claim the visual change works without the measured verdict."}'
  exit 0
fi

rm -f "$pending" "$verified"
exit 0
