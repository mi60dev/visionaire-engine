# Contributing to Visionaire Engine

Bug reports, feature requests, and pull requests are welcome — open an issue
first for anything larger than a small fix. **Field reports from real debugging
sessions are especially valued** — a description of where a tool got clumsy or
gave the wrong context has driven most releases so far.

## License of contributions

Visionaire Engine is licensed under the [Apache License 2.0](LICENSE). By
submitting a contribution (a pull request, patch, or code in an issue), you agree
it is provided under that same Apache-2.0 license (inbound = outbound), and you
certify you have the right to submit it — it's your own work, or you're otherwise
permitted to contribute it (for example, not restricted by an employer's IP
policy). You keep the copyright to your contribution.

## Development

See [docs/development.md](docs/development.md) for building, testing, and the
architecture. In short: `npm install && npm run build`, `npm test` for the full
suite (e2e auto-skips without Chrome), and `npm run demo` is the fastest edit-run
loop. Please keep new behavior covered by tests.
