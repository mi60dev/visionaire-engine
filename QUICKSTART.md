# Quick Start

## Run with Docker (Easiest)

```bash
docker build -t visionaire-engine .
docker run -i visionaire-engine
```

That's it. The MCP server starts on stdio.

## Run Locally (No Docker)

**Prerequisites:**
- Node.js 20+
- Chrome or Chromium (for puppeteer-core)

```bash
npm install
npm run build
npm run dev
# or: node dist/index.js
```

## Use with Claude

Once running, connect it to Claude Code:

1. In Claude Code, add the MCP server config to your settings
2. Point it to: `npx visionaire-engine`
3. Start using `solve()` to diagnose visual issues

Example query:
```
"Why is my button red when it should be blue?"
```

The tool will:
1. Route your question to the best diagnostic scenario
2. Ask for missing context if needed
3. Execute the full diagnostic sequence
4. Return findings with cascade chains and file:line attribution

## What It Does

The `solve` tool provides **deterministic visual debugging for web pages**:
- Describe a problem in plain English
- Get cascade chains with file:line for CSS rules
- See measured geometry, visibility verdicts, and blast radius
- Verify fixes with before/after comparisons

See [SOLVE_GUIDE.md](SOLVE_GUIDE.md) for complete documentation.

## For Development

```bash
npm install      # Install dependencies
npm run build    # Compile TypeScript
npm run dev      # Run in dev mode (tsx, watches files)
npm test         # Run tests
```

## Docker Image Details

- **Base:** Node 20 Alpine (~150MB)
- **Chrome:** Added via apk (~100MB)
- **Final size:** ~360MB
- **Fully offline:** No external dependencies

## Troubleshooting

**"Chrome not found"**
- Docker: Already included
- Local: Install Chrome/Chromium manually, or use `PUPPETEER_EXECUTABLE_PATH`

**"MCP not connecting"**
- Make sure the server is running (`docker run ...`)
- Check the config points to the right entrypoint
- See main README for detailed setup

**"solve() returns no match"**
- Try rephrasing the problem
- Use old tools directly: `inspect_element`, `explain_styles`, etc.
- File an issue with your query to expand scenarios

## Next Steps

- Read [SOLVE_GUIDE.md](SOLVE_GUIDE.md) for full documentation
- Explore scenarios in `src/scenarios.ts`
- Add custom scenarios if needed (no code changes required)
