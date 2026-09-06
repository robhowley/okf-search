# okf-search

`okf-minisearch` searches [Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/open-knowledge-format) Markdown loaded from a Node.js directory, files selected in a browser, or Markdown already in memory. The companion `pi-okf-search` package retrieves ranked snippets from a configured local OKF directory through one read-only `okf_search` tool backed by a native Rust/Tantivy index.

[![Package validation](https://github.com/robhowley/okf-search/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/robhowley/okf-search/actions/workflows/ci.yml)
[![okf-minisearch on npm](https://img.shields.io/npm/v/okf-minisearch?logo=npm&label=okf-minisearch)](https://www.npmjs.com/package/okf-minisearch)
[![pi-okf-search on npm](https://img.shields.io/npm/v/pi-okf-search?logo=npm&label=pi-okf-search)](https://www.npmjs.com/package/pi-okf-search)

## Choose an entry point

- **Node.js and browser users:** [`okf-minisearch`](packages/okf-minisearch/README.md) is the ESM library and TypeScript API.
- **Pi users:** [`pi-okf-search`](packages/pi-okf-search/README.md) searches one configured local OKF tree from a Pi session.
- **Contributors:** see [Development](#development) for workspace setup and checks.

## Use from Node.js

```sh
npm install okf-minisearch
```

Given an OKF Markdown tree in `./knowledge`:

```js
import { openOkf } from "okf-minisearch";

const okf = await openOkf("./knowledge");
const [hit] = okf.search("rollback snapshot", { limit: 1 });

if (!hit) throw new Error("No matches.");

console.log({
  title: hit.title,
  path: hit.path,
  headingPath: hit.headingPath,
  startLine: hit.startLine,
  endLine: hit.endLine,
  snippet: hit.snippet,
});
```

```text
{
  title: 'Database rollback',
  path: 'runbooks/database-rollback.md',
  headingPath: 'Database rollback > Restore snapshot',
  startLine: 9,
  endLine: 11,
  snippet: 'Restore the last known-good snapshot, then verify application health.'
}
```

## Use in a browser

Load the browser API without installing or bundling:

```html
<script src="https://cdn.jsdelivr.net/npm/okf-minisearch@2"></script>
```

Use `OkfMiniSearch` in your script. See the [browser guide](packages/okf-minisearch/README.md#browser) for file selection and search examples.

## Demo

Try [okf-minisearch in your browser](https://robhowley.com/okf-search/). Search a sample OKF corpus and validate Markdown uploads entirely in memory.

## Library capabilities

- Loads OKF Markdown from a Node.js directory, browser-selected files, or in-memory strings.
- Returns one ranked section per document with its title, path, heading path, line range, and snippet.
- Provides phrase-level `autoSuggest` completions; see the [library auto-suggest guide](packages/okf-minisearch/README.md#auto-suggest).
- Filters by type, tags, status, trust tier, and staleness.
- Provides `ingest` for add/replace updates and `remove` for explicit in-memory removal. Malformed replacements leave existing records searchable, and source files stay unchanged.

```text
OKF Markdown → openOkf() → in-memory MiniSearch index → relevant section
```

## Use from Pi

Once `pi-okf-search` is available on npm, install it globally:

```sh
pi install npm:pi-okf-search
```

Merge a root into `~/.pi/agent/settings.json` (use an absolute path for the clearest first setup):

```json
{
  "pi-okf-search": {
    "root": "/absolute/path/to/knowledge"
  }
}
```

Start Pi with a search prompt:

```sh
pi "Search the knowledge base to find the rollback procedure."
```

The model can call `okf_search`, inspect ranked snippets, and reopen a result's exact line range with Pi's `read` tool. See the [Pi package guide](packages/pi-okf-search/README.md) for global and project-local installation, settings precedence and trust, every search control, output interpretation, troubleshooting, and security limits.

## Requirements and documentation

- **Library:** ESM-only. Node.js usage requires Node.js 20 or newer; browser usage starts from files selected by the user.
- **Pi package:** Node.js `>=22.19.0`. Its tests pin `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` `0.84.3`; the peer dependency ranges do not establish a narrower supported Pi version range.
- **Pi package loading:** the package manifest exposes `./extensions/okf-search`; Pi discovers the extension entry point from that directory.
- [Node.js package documentation](packages/okf-minisearch/README.md)
- [Pi package documentation](packages/pi-okf-search/README.md)
- [Pinned OKF v0.2 specification](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/ad30107c31c06aec8a7d5636e0d1058118604e6f/SPEC.md)
- [MiniSearch documentation](https://lucaong.github.io/minisearch/)

## Development

The full workspace requires Node.js `>=22.19.0` and pnpm `11.22.0`.

```sh
pnpm install
pnpm package:check
```

`pnpm package:check` performs a frozen install, builds, type-checks, tests, retains the demo check, and exercises packed Node, browser, and Pi consumers.

Build only the JavaScript library:

```sh
pnpm --filter okf-minisearch build
```

Run the Pi extension from this checkout:

```sh
pnpm --filter okf-search-native build
pi -e ./packages/pi-okf-search/extensions/okf-search/index.ts
```

The native backend must be built before this local extension command. The Pi package has no build step; Pi loads its TypeScript source.

## License

Released under the [MIT License](LICENSE).
