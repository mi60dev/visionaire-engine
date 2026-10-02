const api = globalThis.browser ?? globalThis.chrome
const q = new URLSearchParams(location.search)
const url = q.get('url') ?? ''
let origin = url
try {
  const u = new URL(url)
  origin = u.protocol === 'file:' ? 'local files (file://)' : u.origin
} catch {
  // shown raw
}
document.getElementById('origin').textContent = origin
document.getElementById('url').textContent = url.slice(0, 300)
document.getElementById('why').textContent = `The agent asked to ${(q.get('why') ?? 'open it').slice(0, 80)}. This request expires in 2 minutes.`

async function decide(decision) {
  await api.runtime.sendMessage({ type: 'approve.decide', id: q.get('id'), decision })
  window.close()
}
for (const d of ['once', 'always', 'deny']) document.getElementById(d).addEventListener('click', () => void decide(d))
window.addEventListener('beforeunload', () => void api.runtime.sendMessage({ type: 'approve.decide', id: q.get('id'), decision: 'deny' }))
