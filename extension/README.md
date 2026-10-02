# Visionaire Bridge (browser extension)

Lets a local Visionaire MCP server inspect pages in **your own browser** — real profile, logged-in sessions — so your coding agent can debug what you actually see.

## Install

```bash
npm run build:extension    # from the repo root → extension/dist/{chrome,firefox} (+ .zip / .xpi)
```

| Browser | Steps |
|---|---|
| Chrome, Edge, Brave, Arc (Chromium 125+) | `chrome://extensions` → enable **Developer mode** → **Load unpacked** → `extension/dist/chrome` |
| Firefox 140+ | `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → `extension/dist/firefox/manifest.json` (temporary add-ons unload on restart; for a permanent install, sign the `.xpi` as an unlisted add-on on AMO) |

## Which port?

Nothing to configure: servers use `17337` (extra servers take the next free ports and are found automatically). Only if you set `VISIONAIRE_BRIDGE_PORT` on a machine, enter the same number under **Bridge port** in the popup.

## Pair (once)

1. Start your agent — the MCP server opens the bridge on `ws://127.0.0.1:17337`. Extra servers take the next free ports; the extension only probes 17337 and learns the others from it (if you change `VISIONAIRE_BRIDGE_PORT`, set the same **Bridge port** in the popup).
2. Ask the agent to inspect something with `connect { mode: "extension" }`. The first time, it answers with a **one-time pairing code** (e.g. `KX4M-9TQR-P2HW`, valid 5 minutes).
3. Click the Visionaire icon (badge **!**), paste the code next to your project, press **Pair**. Then the agent connects again.

The code pairs every Visionaire server on this machine (they share `~/.visionaire/bridge-token`). `Reset pairing` in the popup, or `visionaire-engine reset-pairing`, revokes it.

## Use

- `connect { mode: "extension", url: "https://…" }` — the agent opens the page in its own tab (Chrome groups these as **Visionaire**); later connects reuse that tab.
- **Sites need your consent.** `localhost`, `127.0.0.1`, `*.localhost` and `*.test` are pre-approved (your dev servers). For any other site a small window asks: **Allow once**, **Always allow this site**, or **Deny**. Remove remembered sites in the popup.
- `connect { mode: "extension" }` without a url inspects the tab you shared with **Share this tab** (sharing approves that tab's site for that tab).
- If an inspected tab navigates to a site you haven't approved, the extension detaches at once and the agent is told why. **Revoke** any tab from the popup.

Chrome shows "Visionaire Bridge started debugging this browser" while a tab is inspected — that is `chrome.debugger`, and it cannot be hidden. Clicking **Cancel** stops inspection; the agent is told.

## Windows with WSL

Run the MCP server inside WSL and the extension in your **Windows** browser — no Linux Chrome needed. The extension dials `127.0.0.1:17337`; WSL 2 forwards Windows localhost to services in WSL.

- **Recommended (Windows 11 22H2+):** mirrored networking makes `localhost` identical on both sides. Add to `%UserProfile%\.wslconfig`, then run `wsl --shutdown`:
  ```ini
  [wsl2]
  networkingMode=mirrored
  ```
- **Default NAT mode** relies on WSL's localhost forwarding (on by default, `localhostForwarding=true`). If the popup never shows a server, switch to mirrored mode.
- **Check it:** from Windows PowerShell, `curl.exe http://127.0.0.1:17337/` should print `visionaire bridge: WebSocket only`.
- Dev servers running in WSL (`localhost:3000`) open in the Windows browser through the same forwarding.
- `file://` pages don't carry over (`/home/...` is not a Windows path) — serve them over http instead.
- The pairing key lives in WSL (`~/.visionaire/bridge-token`); pairing works the same way.

## What each browser can do

| Capability | Chrome-family | Firefox |
|---|---|---|
| Transport | `chrome.debugger` → full DevTools Protocol, relayed to the engine | content-script collector (`collector.js`), fixed command set |
| Cascade winner, losers, reasons, file:line | ✓ incl. source maps, user-agent rules | ✓ from CSSOM; lines recovered by parsing the fetched stylesheet; no UA rules; `@layer` order approximated |
| Visibility, overlap, clipping, stacking chain | ✓ | ✓ (`elementsFromPoint`, computed styles) |
| Snapshot with uids, find by text/role | ✓ | ✓ (`f`-prefixed uids) |
| Animations / transitions | ✓ | ✓ (`getAnimations`) |
| Screenshots | ✓ | ✓ (`captureVisibleTab`, brings the tab to front) |
| Event listeners, interactions, `inject_css`, viewport emulation, `evaluate` | ✓ | ✗ — Firefox gives extensions no DevTools Protocol, and Mozilla policy forbids running server-sent code |

## Security model

Threats considered: web pages (they can open sockets to localhost), DNS rebinding, other local processes or add-ons posing as either side, and a prompt-injected agent (a hostile page talking the agent into misusing your logged-in browser).

- **Transport.** The extension only dials out to `127.0.0.1`; it opens no ports. The server binds loopback only, requires `Host` = `127.0.0.1`/`localhost` (DNS rebinding) and `Origin` = this extension (Chrome ID pinned via the manifest `key`: `dlmobdbalnhldnkkemdljkegfgjbndei`; Firefox UUIDs are random per install, so pairing is what authenticates it). Store builds with another ID: `VISIONAIRE_BRIDGE_EXTENSION_IDS`.
- **Pairing.** The key never crosses the wire in the clear. A one-time ~59-bit code, shown only to you by the agent, opens a 5-minute window (5 attempts); the key is then delivered AES-256-GCM-sealed under that code. Every later handshake is mutual HMAC-SHA256 bound to both nonces **and the port**, so a rogue listener cannot relay a real server's proof.
- **Robustness.** Pre-auth frames are capped at 4 KB and must be JSON objects; at most 16 pending sockets; a bad frame closes that socket, never the MCP process. Before authentication the server reveals only a project name.
- **Tabs.** The agent touches only tabs it opened or you shared; it cannot list or read your other tabs.
- **Sites.** Consent per site (above); an inspected tab that navigates to an unapproved site is detached immediately, and protocol commands are refused while the tab is on one.
- **Protocol.** Only the DevTools domains the engine needs are relayed; cookie, storage, response-body, download, browser and new-target methods are refused even on approved tabs.
- **In your browser the engine is stricter:** `evaluate` (agent-written JavaScript) is off, and `inject_css` refuses `url()`/`@import`/`image-set()` (CSS-based data exfiltration). Opt back in with `VISIONAIRE_EXTENSION_EVALUATE=1`. `beforeunload` is never auto-accepted, so unsaved work survives.
- **Firefox** runs a fixed collector bundled in the extension — no code strings are ever sent (Mozilla's no-remote-code policy) — and `lite.fetch` reads only stylesheets the inspected page itself loads, with cookies only for the page's own origin.
- **Permissions.** Chrome: `debugger`, `tabs`, `tabGroups`, `storage`, `alarms` — no host permissions. Firefox: `<all_urls>` to run the collector and fetch stylesheet sources.

Residual risk: on a site you approved, the agent can read what you can read there and drive the page (clicks, typing) — approve only sites you are debugging.

## Files

| File | Role |
|---|---|
| `src/background.js` | connection manager, pairing, tab policy, CDP relay (Chrome) / collector runner (Firefox) |
| `src/collector.js` | self-contained in-page inspector for the lite engine (also used by the Node test-suite) |
| `src/popup.*` | approve servers, share/revoke tabs, settings |
| `../src/bridge/` | Node side: WebSocket server, puppeteer transport over the bridge, lite analysis |
| `../scripts/build-extension.ts` | manifests (Chrome MV3, Firefox MV2 persistent background), icons, archives |

Tests: `test/bridge.e2e.test.ts` (real Chrome + built extension) and `test/firefox.e2e.test.ts` (real Firefox, skipped when not installed).
