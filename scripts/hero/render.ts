/** Render the README hero image from scripts/hero/hero.html:  npx tsx scripts/hero/render.ts */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'
import { findChromeExecutable } from '../../src/session.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const browser = await puppeteer.launch({ executablePath: findChromeExecutable(), headless: true })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 2 })
await page.goto(pathToFileURL(path.join(here, 'hero.html')).href)
await page.screenshot({ path: path.resolve(here, '..', '..', 'hero.png') as `${string}.png` })
await browser.close()
console.log('wrote hero.png (2560×1440)')
