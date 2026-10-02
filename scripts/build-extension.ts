/**
 * Build the Visionaire Bridge extension for Chrome (MV3) and Firefox (MV2,
 * persistent background — Firefox MV3 event pages unload while idle, which
 * would drop the bridge socket).
 *
 *   npm run build:extension      → extension/dist/{chrome,firefox}/ + .zip
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodePng } from '../src/engine/png-encode.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(root, 'extension', 'src')
const out = path.join(root, 'extension', 'dist')
const version = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version

const NAME = 'Visionaire Bridge'
const DESCRIPTION = 'Lets your local Visionaire MCP server inspect pages in this browser — cascade, layout, visibility, animations — for your coding agent.'
const ICONS = { '16': 'icons/icon-16.png', '32': 'icons/icon-32.png', '48': 'icons/icon-48.png', '128': 'icons/icon-128.png' }

/**
 * Public key → stable extension ID (dlmobdbalnhldnkkemdljkegfgjbndei) for unpacked
 * installs, so the bridge server can pin the exact Origin. (Web Store builds get
 * a store-assigned ID; allow it via VISIONAIRE_BRIDGE_EXTENSION_IDS.)
 */
const CHROME_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArvPzghP/6jUOpTa01+b2fD9bpsv61iDPDdwQZgJvHK/66DCCi78Avt2S0Grez1wWuOFS9u9axbyUTM2PwXPIlQm0tEYNXutLVJEcCyuY5h4QbIFaBVihDPhPeFqoPC8VSg/AvKVFBd9j6+Py7mkGg8Cn/MB3vaJH/zQUNvH5tJSSksZsC9ty1pCZNGAj0m6N+B7+RdcE/Xc1MDOk5Rrvt4iSajOlw4EVMzNmvnEAUbKAhG6YjAgaGC7411WijCwnKllZNhRwNrQSUOc/Xp1Z84jR5xhL2SgExZAyrcgRkjAMXAisuo6yE3Y1vYZXW+6HyoSf32/YHpGKrk3s4BVpQQIDAQAB'

const chromeManifest = {
  manifest_version: 3,
  key: CHROME_KEY,
  name: NAME,
  version,
  description: DESCRIPTION,
  // 125: chrome.debugger child sessions (OOPIF) + 116+ WebSocket keepalive for workers.
  minimum_chrome_version: '125',
  background: { service_worker: 'background.js', type: 'module' },
  // No host permissions: CDP via chrome.debugger needs none, so the install prompt stays minimal.
  permissions: ['debugger', 'tabs', 'tabGroups', 'storage', 'alarms'],
  action: { default_popup: 'popup.html', default_title: NAME, default_icon: ICONS },
  icons: ICONS,
}

const firefoxManifest = {
  manifest_version: 2,
  name: NAME,
  version,
  description: DESCRIPTION,
  browser_specific_settings: {
    gecko: {
      id: 'visionaire-bridge@mi60dev',
      strict_min_version: '140.0',
      data_collection_permissions: { required: ['none'] },
    },
    // Desktop extension; Android's data_collection_permissions support starts at 142.
    gecko_android: { strict_min_version: '142.0' },
  },
  background: { page: 'background.html', persistent: true },
  // <all_urls>: scripting.executeScript into inspected tabs + fetching stylesheet
  // sources (with the user's cookies) to resolve rule line numbers.
  permissions: ['tabs', 'storage', 'alarms', 'scripting', '<all_urls>'],
  browser_action: { default_popup: 'popup.html', default_title: NAME, default_icon: ICONS },
  icons: ICONS,
}

/** Purple rounded square with a white "eye": ring + pupil. Anti-aliased via coverage sampling. */
function icon(size: number): Buffer {
  const px = Buffer.alloc(size * size * 4)
  const S = 4 // supersampling
  const c = size / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0
      let fg = 0
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const fx = x + (sx + 0.5) / S
          const fy = y + (sy + 0.5) / S
          // rounded square, radius 22%
          const r = size * 0.22
          const qx = Math.max(Math.abs(fx - c) - (c - r), 0)
          const qy = Math.max(Math.abs(fy - c) - (c - r), 0)
          if (Math.hypot(qx, qy) > r) continue
          bg++
          const d = Math.hypot(fx - c, fy - c)
          const ring = d > size * 0.26 && d < size * 0.36
          const pupil = d < size * 0.13
          if (ring || pupil) fg++
        }
      }
      const a = bg / (S * S)
      const t = bg ? fg / bg : 0
      const i = (y * size + x) * 4
      px[i] = Math.round(0x6d * (1 - t) + 255 * t)
      px[i + 1] = Math.round(0x28 * (1 - t) + 255 * t)
      px[i + 2] = Math.round(0xd9 * (1 - t) + 255 * t)
      px[i + 3] = Math.round(a * 255)
    }
  }
  return encodePng(size, size, px)
}

// Drop archives from earlier versions so a release never ships a stale build.
fs.mkdirSync(out, { recursive: true })
for (const f of fs.readdirSync(out)) if (/^visionaire-bridge-.*\.(zip|xpi)$/.test(f)) fs.rmSync(path.join(out, f))

function build(target: 'chrome' | 'firefox', manifest: object): void {
  const dir = path.join(out, target)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, 'icons'), { recursive: true })
  for (const f of ['background.js', 'collector.js', 'protocol.js', 'popup.html', 'popup.js', 'popup.css', 'approve.html', 'approve.js']) {
    fs.copyFileSync(path.join(src, f), path.join(dir, f))
  }
  if (target === 'firefox') fs.copyFileSync(path.join(src, 'background.html'), path.join(dir, 'background.html'))
  for (const s of [16, 32, 48, 128]) fs.writeFileSync(path.join(dir, 'icons', `icon-${s}.png`), icon(s))
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  const zip = path.join(out, `visionaire-bridge-${target}-${version}.${target === 'firefox' ? 'xpi' : 'zip'}`)
  fs.rmSync(zip, { force: true })
  const res = spawnSync('zip', ['-qr', zip, '.'], { cwd: dir })
  console.log(`built ${path.relative(root, dir)}${res.status === 0 ? `  (+ ${path.relative(root, zip)})` : '  (zip not available — skipped archive)'}`)
}

build('chrome', chromeManifest)
build('firefox', firefoxManifest)
