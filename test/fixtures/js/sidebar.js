// Fixture handlers for record_interaction e2e (SPEC §14.4/§14.5). Line
// positions are load-bearing: test/interaction.e2e.test.ts asserts that the
// timeline attributes handlers to this file. Keep edits append-only.
'use strict';

var sidebar = document.getElementById('sidebar');
var content = document.getElementById('content');

function busyWait(ms) {
  var end = performance.now() + ms;
  while (performance.now() < end) {
    // burn the frame so the Long Animation Frames API attributes it
  }
}

function toggleSmooth() {
  sidebar.classList.toggle('collapsed');
}

// Kills the width transition mid-flight: display:none removes it — the jump.
// Empirical (Chrome headless, CDP Animation domain): killing the transition in
// the same task — or even one rAF later (the class-add and display:none then
// coalesce into a single style recalc) — means it NEVER reaches
// animationStarted; CDP reports only animationCreated+animationCanceled with
// no target/property payload. Deferring display:none by two frames lets the
// transition genuinely start before it dies: the started→CANCELLED pair of
// SPEC §14.4.
function toggleBroken() {
  sidebar.classList.add('collapsed');
  requestAnimationFrame(function () {
    requestAnimationFrame(killTransition);
  });
}

function killTransition() {
  sidebar.style.display = 'none';
  busyWait(80); // make this frame long enough for LoAF script attribution
}

function toggleInstant() {
  var badge = document.getElementById('badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.id = 'badge';
    badge.className = 'badge';
    badge.textContent = 'highlighted';
    content.appendChild(badge);
  } else {
    badge.textContent = 'highlighted again';
  }
  content.classList.toggle('highlight'); // no transition declared — instant by design
}

document.getElementById('btn-smooth').addEventListener('click', toggleSmooth);
document.getElementById('btn-broken').addEventListener('click', toggleBroken);
document.getElementById('btn-instant').addEventListener('click', toggleInstant);
