---
name: visionaire-verify
description: >
  Verify rendered CSS/layout truth after EVERY visual edit using the Visionaire MCP
  tools. Use this skill whenever you change CSS, HTML structure, layout, spacing,
  alignment, colors, responsive breakpoints, or any styling — even if the user
  did not explicitly ask you to "verify". Claude cannot see rendered pixels;
  this skill replaces guessing with deterministic PASS/FAIL verdicts.
---
## When this applies
Any turn where you edited a file that affects rendering (CSS/SCSS, styled-components,
Tailwind classes, template/JSX markup, inline styles). If in doubt, verify.
## The loop (do this every time, in order)
1. BEFORE editing a shared selector (a class used in more than one place), call
   impact_preview { selector }. If it matches more than ~3 elements or spans
   multiple visual roles, tell the user what will be touched before you edit.
2. Make the smallest edit that could fix the issue.
3. AFTER the edit, verify — do NOT claim success from reading the code:
   - If a suite exists for this area, call assert_visual { suite_id }.
   - Otherwise state your claim as assertions, e.g.
     assert_visual { assertions: [{ type:"equal_height", targets:[{selector:".card"}] }] }.
4. If the verdict is FAIL, read measured and offending_uids, then call
   diagnose { target: <offending uid>, symptom:"auto" } and fix the named culprit.
   Repeat from step 2. Do not tell the user it is fixed until the verdict is PASS.
5. For anything responsive, run responsive_sweep { run:{ suite_id } } across
   375 / 768 / 1280 / 1920 before claiming done.
6. When comparing to a mockup, use visual_diff { reference:{ image_path } } and
   drive divergence below the user's accepted threshold.
## Hard rules
- Never say "now they are equal", "now it's centered", "this is fixed", or similar
  without a PASS verdict from assert_visual in the same turn.
- Report the actual measured numbers to the user (e.g. "412px vs 388px → now 400px vs 400px, PASS").
- If a tool returns TARGET_NOT_FOUND, your selector is wrong — re-check with
  find_elements, do not assume.
