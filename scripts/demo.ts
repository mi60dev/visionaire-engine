/**
 * CLI demo (not the MCP server — console.log is fine here):
 *   npm run demo                          # cascade fixture, '.hero-cta .btn'
 *   npm run demo -- https://example.com --selector "h1"
 * Headless when stdout is not a TTY; a visible Chrome window otherwise.
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SessionManager } from '../src/session.js'
import { explainStylesTool } from '../src/tools/explain-styles.js'
import { pageSnapshotTool } from '../src/tools/page-snapshot.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_URL = pathToFileURL(path.resolve(here, '../test/fixtures/cascade.html')).href
const DEFAULT_SELECTOR = '.hero-cta .btn'

interface DemoArgs {
  url: string
  selector: string
}

function parseArgs(argv: string[]): DemoArgs {
  let url = DEFAULT_URL
  let selector = DEFAULT_SELECTOR
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--selector') {
      const value = argv[++i]
      if (value === undefined) {
        console.error('--selector requires a value')
        process.exit(2)
      }
      selector = value
    } else if (arg.startsWith('--selector=')) {
      selector = arg.slice('--selector='.length)
    } else if (arg === '--help' || arg === '-h') {
      console.log('usage: npm run demo [-- <url>] [--selector ".css .selector"]')
      process.exit(0)
    } else {
      url = arg
    }
  }
  return { url, selector }
}

async function main(): Promise<void> {
  const { url, selector } = parseArgs(process.argv.slice(2))
  const headless = !process.stdout.isTTY
  const session = new SessionManager()
  try {
    console.log(`connecting (launch, headless: ${headless}) → ${url}`)
    const ctx = await session.connect({ mode: 'launch', headless, url })

    console.log('\n=== page_snapshot ===\n')
    const snapshot = await pageSnapshotTool.handler(ctx, {})
    console.log(snapshot.text)

    console.log(`\n=== explain_styles ${selector} ===\n`)
    const why = await explainStylesTool.handler(ctx, { selector })
    console.log(why.text)
  } finally {
    await session.disconnect()
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
