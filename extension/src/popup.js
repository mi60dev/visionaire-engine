const api = globalThis.browser ?? globalThis.chrome
const $ = (id) => document.getElementById(id)

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v)
    else n.setAttribute(k, v)
  }
  for (const c of children) n.append(c)
  return n
}

async function send(msg) {
  return api.runtime.sendMessage(msg)
}

async function render(s) {
  $('mode').textContent = s.caps.includes('cdp') ? 'full CDP' : 'lite (DOM/CSSOM)'
  $('mode').title = s.caps.includes('cdp')
    ? 'Chrome: full DevTools Protocol — cascade with file:line, listeners, animations, screenshots'
    : 'Firefox: no DevTools Protocol for extensions — cascade via CSSOM, visibility, hit-testing, animations'
  $('allowOpen').checked = s.allowOpen
  $('openActive').checked = s.openActive
  if (document.activeElement !== $('basePort')) $('basePort').value = String(s.basePort)

  const servers = $('servers')
  servers.replaceChildren()
  if (!s.servers.length) servers.append(el('p', { class: 'muted' }, 'No Visionaire MCP server running. Start your agent (it launches the server), then wait a few seconds.'))
  for (const srv of s.servers) {
    const name = srv.server?.project || srv.project || `port ${srv.port}`
    const sub = srv.server ? `${srv.server.cwd} · v${srv.server.version} · :${srv.port}` : `:${srv.port}`
    if (srv.status === 'pairing') {
      const input = el('input', { type: 'text', placeholder: 'XXXX-XXXX-XXXX', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Pairing code' })
      const submit = async () => {
        if (input.value.trim()) render(await send({ type: 'popup.pair', port: srv.port, code: input.value }))
      }
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void submit()
      })
      servers.append(
        el('div', { class: 'callout' },
          el('div', {}, el('strong', {}, name), ' wants to pair. Paste the code your agent showed you:'),
          el('div', { class: 'row' }, input, el('button', { onclick: submit }, 'Pair')),
          srv.error ? el('div', { class: 'sub warn' }, srv.error) : el('div', { class: 'sub' }, 'Only pair with a server you started.')))
    } else if (srv.status === 'unpaired') {
      servers.append(
        el('div', { class: 'callout' }, el('strong', {}, name), ' is not paired yet. Ask your agent to connect with mode "extension" — it will show you a pairing code.'))
    } else if (srv.status === 'mismatch') {
      servers.append(el('div', { class: 'callout' }, el('strong', {}, name), ': pairing key changed on this machine. Use “Reset pairing”, then pair again.'))
    } else {
      servers.append(el('div', { class: 'row' }, el('span', { class: 'dot' }), el('div', { class: 'grow' }, el('div', { class: 'title' }, name), el('div', { class: 'sub' }, sub))))
    }
  }

  const sites = $('sites')
  sites.replaceChildren()
  if (!s.sites.length) sites.append(el('p', { class: 'muted' }, 'None yet — localhost and *.test are always allowed. The agent asks before opening anything else.'))
  for (const site of s.sites) {
    sites.append(el('div', { class: 'row' }, el('div', { class: 'grow title' }, site), el('button', { class: 'link', onclick: async () => render(await send({ type: 'popup.forgetSite', site })) }, 'Remove')))
  }

  const [active] = await api.tabs.query({ active: true, currentWindow: true })
  const current = $('current')
  current.replaceChildren()
  if (active) {
    const visible = s.tabs.find((t) => t.tabId === active.id)
    const inspectable = /^(https?|file):/.test(active.url || '')
    current.append(
      el('div', { class: 'row' },
        el('div', { class: 'grow' }, el('div', { class: 'title' }, active.title || active.url || 'Untitled'), el('div', { class: 'sub' }, active.url || '')),
        inspectable
          ? visible
            ? el('button', { class: 'secondary', onclick: async () => render(await send({ type: 'popup.unshare', tabId: active.id })) }, 'Stop sharing')
            : el('button', { onclick: async () => render(await send({ type: 'popup.share', tabId: active.id })) }, 'Share this tab')
          : el('span', { class: 'sub' }, 'not inspectable')))
  }

  const tabs = $('tabs')
  tabs.replaceChildren()
  if (!s.tabs.length) tabs.append(el('p', { class: 'muted' }, 'None. Share this tab, or let the agent open its own.'))
  for (const t of s.tabs) {
    tabs.append(
      el('div', { class: 'row' },
        el('span', { class: t.inspecting ? 'dot' : 'dot warn', title: t.inspecting ? 'being inspected' : 'idle' }),
        el('div', { class: 'grow' }, el('div', { class: 'title' }, t.title || t.url), el('div', { class: 'sub' }, `${t.owned ? 'opened by agent' : 'shared by you'} · ${t.url}`)),
        el('button', { class: 'link', onclick: async () => render(await send({ type: 'popup.unshare', tabId: t.tabId })) }, 'Revoke')))
  }
}

$('rescan').addEventListener('click', async () => render(await send({ type: 'popup.rescan' })))
$('repair').addEventListener('click', async () => render(await send({ type: 'popup.repair' })))
$('allowOpen').addEventListener('change', async (e) => render(await send({ type: 'popup.settings', allowOpen: e.target.checked })))
$('basePort').addEventListener('change', async (e) => render(await send({ type: 'popup.settings', basePort: Number(e.target.value) })))
$('openActive').addEventListener('change', async (e) => render(await send({ type: 'popup.settings', openActive: e.target.checked })))

render(await send({ type: 'popup.state', wake: true }))
setInterval(async () => {
  if (document.activeElement?.tagName === 'INPUT' && ['text', 'number'].includes(document.activeElement.type)) return
  render(await send({ type: 'popup.state' }))
}, 1500)
