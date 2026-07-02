// case21-sidebar.js — the buggy hide handler: adding .collapsed starts the
// 300ms width transition; the premature "cleanup" timeout then sets
// display:none while the transition is still running — cancelling it
// mid-flight. The busy-wait burns the click frame past the ~50ms
// Long-Animation-Frame threshold so the platform attributes this script.
'use strict';

var sidebar = document.querySelector('.sidebar');

function hideSidebar() {
  sidebar.classList.add('collapsed');
  setTimeout(function () {
    sidebar.style.display = 'none';
  }, 100);
  var end = performance.now() + 80;
  while (performance.now() < end) {
    // burn the frame for LoAF attribution
  }
}

document.querySelector('.toggle').addEventListener('click', hideSidebar);
