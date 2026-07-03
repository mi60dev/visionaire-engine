# Install in your MCP client

Visionaire is a standard **stdio MCP server**, so it works in any MCP-capable
client — Claude, GitHub Copilot, Cursor, Google Antigravity, Windsurf, Zed, and
others. The server is identical everywhere; only the registration differs.

## One-time build

Every client below launches the built file `dist/index.js`, so build once first:

```bash
git clone https://github.com/mi60dev/visionaire-engine
cd visionaire-engine
npm install
npm run build          # produces dist/index.js
```

Then use the **absolute** path to `dist/index.js` in the configs below. On
macOS/Linux, `echo "$PWD/dist/index.js"` prints it; on Windows use the full
`C:\...\dist\index.js` path with escaped backslashes in JSON (`\\`).

## Prerequisite: a Chrome/Chromium browser

visionaire drives a real browser via the Chrome DevTools Protocol, and
`puppeteer-core` **does not bundle one** — so you need Chrome or Chromium
installed. On macOS and Windows with Chrome installed, it's found automatically.
If you get *"No Chrome/Chromium found"* (common on a fresh **Linux / WSL / Docker**
box), install one:

```bash
# Debian / Ubuntu / WSL — apt resolves the required system libraries for you:
curl -fsSLO https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt-get install -y ./google-chrome-stable_current_amd64.deb    # → /usr/bin/google-chrome, auto-detected

# or fetch a self-contained Chrome for Testing and point CHROME_PATH at it:
npx @puppeteer/browsers install chrome@stable
export CHROME_PATH="/path/printed/by/the/command/chrome"
```

`CHROME_PATH` overrides browser discovery in every environment. See
[Troubleshooting](#troubleshooting) below if Chrome is installed but won't launch.

> **Two schema gotchas that break copy-paste between clients:**
> 1. **VS Code Copilot uses `servers`** as the top-level key. Everyone else uses `mcpServers`.
> 2. **Copilot CLI additionally needs** `"type": "local"` and a `"tools"` field.
> Don't paste one client's block into another without adjusting these.

## Quick reference

| Client | Config location | Top-level key | Notes |
|---|---|---|---|
| Claude Code | `claude mcp add` (writes `~/.claude.json`) | `mcpServers` | CLI command, no hand-editing |
| Claude Desktop | `claude_desktop_config.json` | `mcpServers` | restart the app after editing |
| Cursor | `~/.cursor/mcp.json` (global) / `.cursor/mcp.json` (project) | `mcpServers` | — |
| Copilot — VS Code | `.vscode/mcp.json` (project) / `MCP: Open User Configuration` | **`servers`** | needs **Agent mode**; click **Start** |
| Copilot — CLI | `~/.copilot/mcp-config.json` (or `/mcp add`) | `mcpServers` | needs `type: local` + `tools` |
| Google Antigravity | `~/.gemini/config/mcp_config.json` (global) / `.agents/mcp_config.json` (project) | `mcpServers` | UI: **…** → MCP Servers → View raw config |

---

## Claude Code

```bash
claude mcp add visionaire -- node /abs/path/to/visionaire-engine/dist/index.js
# add -s user before the -- to register it for every project, not just this one
```

Then just ask Claude to use it (`connect to <url> and tell me why …`).

## Claude Desktop

Edit the config file (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`;
Windows: `%APPDATA%\Claude\claude_desktop_config.json`), then **fully restart the app**:

```json
{
  "mcpServers": {
    "visionaire": {
      "command": "node",
      "args": ["/abs/path/to/visionaire-engine/dist/index.js"]
    }
  }
}
```

> Claude Code and the Claude desktop app read **different** config files — see the
> two-config note in [development.md](development.md#registering-with-mcp-clients).

## Cursor

Create `~/.cursor/mcp.json` (available in every project) or `.cursor/mcp.json`
(this project only):

```json
{
  "mcpServers": {
    "visionaire": {
      "command": "node",
      "args": ["/abs/path/to/visionaire-engine/dist/index.js"]
    }
  }
}
```

Enable it under **Cursor Settings → MCP** if it isn't picked up automatically.

## GitHub Copilot — VS Code

Create `.vscode/mcp.json` in your workspace (or run **MCP: Open User Configuration**
from the Command Palette for all workspaces). Note the top-level key is `servers`:

```json
{
  "servers": {
    "visionaire": {
      "type": "stdio",
      "command": "node",
      "args": ["/abs/path/to/visionaire-engine/dist/index.js"]
    }
  }
}
```

Click **Start** above the server entry, then switch Copilot Chat to **Agent mode** —
MCP tools are invisible in Ask and Edit modes.

## GitHub Copilot — CLI

Add to `~/.copilot/mcp-config.json` (or run `/mcp add` inside the CLI and fill the
fields). It needs `type: "local"` and a `tools` list:

```json
{
  "mcpServers": {
    "visionaire": {
      "type": "local",
      "command": "node",
      "args": ["/abs/path/to/visionaire-engine/dist/index.js"],
      "env": {},
      "tools": ["*"]
    }
  }
}
```

Confirm it loaded with `/mcp show` inside the CLI.

## Google Antigravity

Edit `~/.gemini/config/mcp_config.json` (global) or `.agents/mcp_config.json`
(workspace) — or in the IDE click **…** at the top of the agent panel →
**MCP Servers** → **Manage MCP Servers** → **View raw config**:

```json
{
  "mcpServers": {
    "visionaire": {
      "command": "node",
      "args": ["/abs/path/to/visionaire-engine/dist/index.js"]
    }
  }
}
```

Hit **refresh** in the Installed MCP Servers panel after saving.

## Other clients (Windsurf, Zed, …)

Most other clients use the same `mcpServers` + `command`/`args` shape shown above —
point `command` at `node` and `args` at your absolute `dist/index.js` path. If a
client only accepts a single shell command, use: `node /abs/.../dist/index.js`.

---

## Run it from your project directory

visionaire shines when the agent can line up the **live page** with the
**project source** it's editing. Register it per-project (or launch your client
from the project root) so the server's working directory is the site's source
tree — the `connect` response reports that directory back to the agent. Then the
agent can read the real class/id names, templates, and handler files from disk
instead of guessing selectors against the running page.

The server also tells the agent (via MCP "instructions") to **ground before it
searches**: snapshot or read source first, target elements by `uid`, and treat a
no-match as a prompt to look, not to guess again.

## First run in any client

Once registered, drive it in natural language — the agent calls the tools:

1. *"Connect to https://mysite.com and take a page snapshot."*
2. *"Why is the hero button's margin so large?"* → `explain_styles` with file:line.
3. *"The sidebar doesn't hide smoothly — record what happens when I click the toggle."* → `record_interaction`.

For attaching to your **real, logged-in browser** (wp-admin, dashboards) instead
of a fresh one, start Chrome with `--remote-debugging-port=9222` and ask the agent
to `connect` with `browserUrl: "http://127.0.0.1:9222"`. See [tools.md](tools.md)
for the full tool reference.

## Troubleshooting

**"No Chrome/Chromium found."** No browser is installed (or it's in a non-standard
location). Install one per [Prerequisite: a browser](#prerequisite-a-chromechromium-browser),
or set `CHROME_PATH` to an existing binary.

**Chrome is installed but won't launch on WSL / Docker / a Linux server.** Headless
Chrome's sandbox can't initialize in many of these environments. visionaire keeps
the sandbox on by default (it visits untrusted pages) and, when a launch fails
*specifically* because of the sandbox, automatically retries once with
`--no-sandbox` and logs a warning. To control this explicitly:

| Env var | Effect |
|---|---|
| `VISIONAIRE_NO_SANDBOX=1` | Always launch with `--no-sandbox` (skip the retry dance). Convenient on a trusted dev box. |
| `VISIONAIRE_SANDBOX=1` | Never disable the sandbox — fail instead of falling back. Most secure. |
| `VISIONAIRE_CHROME_ARGS="…"` | Extra space-separated flags passed to Chrome (e.g. `--disable-dev-shm-usage` on low-`/dev/shm` Docker). |
| `CHROME_PATH=/path/to/chrome` | Use a specific browser binary. |

Running the MCP server as **root** (typical in Docker) disables the sandbox
automatically, since it can't work there. `--no-sandbox` weakens the browser's
process isolation, so on a machine where you point visionaire at genuinely
untrusted sites, prefer fixing the sandbox (e.g. enable user namespaces) over
disabling it.

**Missing system libraries** (`error while loading shared libraries: libnss3.so`
or similar). Chrome needs a set of shared libs. Installing Google Chrome via the
`.deb` above pulls them in automatically; a manually-downloaded Chrome for Testing
may not. On Debian/Ubuntu: `sudo apt-get install -y libnss3 libatk-bridge2.0-0 libgbm1 libasound2`.
