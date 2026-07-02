/**
 * Handlers for test/fixtures/listeners.html — line numbers are LOAD-BEARING
 * (asserted by test/listeners.e2e.test.ts). CDP reports a listener's source
 * position at the function definition (the "(" after the name), not at the
 * addEventListener call site.
 */
function handleDirectClick(event) {
  event.currentTarget.dataset.clicked = 'yes'
}

function handleWheelPassive(event) {
  // passive:true — an event.preventDefault() here would be silently ignored
}

function handleSaveOnce(event) {
  event.currentTarget.dataset.savedOnce = 'yes'
}

function handleDelegatedClick(event) {
  // vanilla document-level delegation (dispatches on .btn descendants)
}

document.getElementById('direct-btn').addEventListener('click', handleDirectClick)
document.getElementById('scroll-area').addEventListener('wheel', handleWheelPassive, { passive: true })
document.getElementById('once-btn').addEventListener('click', handleSaveOnce, { once: true })
document.addEventListener('click', handleDelegatedClick)
