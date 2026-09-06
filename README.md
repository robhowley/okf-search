# okf-search

Search local [Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/open-knowledge-format) Markdown from Pi, Node.js, or a browser.

This monorepo contains a native Rust/Tantivy search backend, the Pi package built on it, and a JavaScript MiniSearch backend for browsers and Node.js. All three build in-memory indexes; no search service is required.

[![Package validation](https://github.com/robhowley/okf-search/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/robhowley/okf-search/actions/workflows/ci.yml)
[![okf-search-native on npm](https://img.shields.io/npm/v/okf-search-native?logo=npm&label=okf-search-native)](https://www.npmjs.com/package/okf-search-native)
[![pi-okf-search on npm](https://img.shields.io/npm/v/pi-okf-search?logo=npm&label=pi-okf-search)](https://www.npmjs.com/package/pi-okf-search)
[![okf-minisearch on npm](https://img.shields.io/npm/v/okf-minisearch?logo=npm&label=okf-minisearch)](https://www.npmjs.com/package/okf-minisearch)

## Choose a package

| Package | Use it for | Search engine |
| --- | --- | --- |
| [`okf-search-native`](packages/okf-search-native/README.md) | Node.js applications on a supported native platform | Rust and Tantivy |
| [`pi-okf-search`](packages/pi-okf-search/README.md) | Searching a local OKF directory from [Pi](https://pi.dev/) | `okf-search-native` |
| [`okf-minisearch`](packages/okf-minisearch/README.md) | Browser applications, or an ESM-only Node.js backend | MiniSearch |

Use `okf-search-native` for Node-only applications that can use its prebuilt native addons. Use `okf-minisearch` when you need browser support or `autoSuggest`. The backends share OKF preparation and validation behavior, but their ranking, scores, snippets, and fuzzy matches can differ.

## Use from Pi

Install the package:

```sh
pi install npm:pi-okf-search
```

Add the directory to `~/.pi/agent/settings.json`:

```json
{
  "pi-okf-search": {
    "root": "/absolute/path/to/knowledge"
  }
}
```

Start Pi and ask it to search:

```text
Search the knowledge base to find the rollback procedure.
```

The package gives Pi one read-only `okf_search` tool. Results include the source path and inclusive line range so Pi can reopen the exact passage with `read`. Run `/okf status` to inspect the loaded snapshot and `/okf refresh` after files change.

See the [`pi-okf-search` guide](packages/pi-okf-search/README.md) for configuration, query behavior, result interpretation, refreshes, and platform requirements.

## Use the native Node.js backend

```sh
npm install okf-search-native
```

Given an OKF Markdown tree in `./knowledge`:

```js
import { openOkf } from "okf-search-native";

const index = await openOkf("./knowledge");
const [hit] = index.search("rollback snapshot", { limit: 1 });

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

`okf-search-native` can also index Markdown already in memory, validate documents, add or replace documents, remove documents from the current index, and accept prepared documents through `okf-search-native/prepared`. See the [native package guide](packages/okf-search-native/README.md) for its complete API and supported platforms.

## Use the JavaScript backend

Install `okf-minisearch` for Node.js or a bundled browser application:

```sh
npm install okf-minisearch
```

Its package-root API also provides `openOkf`, `createOkfSearch`, document validation, in-memory updates, and search. It additionally supports browser-selected files and `autoSuggest`.

Without a bundler, load its browser API from a CDN:

```html
<script src="https://cdn.jsdelivr.net/npm/okf-minisearch@2"></script>
```

See the [`okf-minisearch` guide](packages/okf-minisearch/README.md) for Node.js, browser, search, and auto-suggest examples.

## How the packages fit together

```text
                         ┌─ okf-search-native ── Node.js
OKF Markdown ─ preparation
                         └─ okf-minisearch ───── Node.js or browser

pi-okf-search ── okf-search-native ── okf_search tool in Pi
```

The public backends share the repository's OKF parsing, validation, document preparation, filters, and result model. When given a directory, they recursively load lowercase `.md` files, excluding files named exactly `index.md` and `log.md`. Search returns at most one best-matching section per document, and both strict and degraded OKF documents are searchable by default.

Indexes remain in memory. Adding or removing a document changes the active index, not its source file. Reopening a directory rebuilds the index from disk.

## Requirements

| Package | Runtime |
| --- | --- |
| `okf-search-native` | Node.js `>=22.19.0`; macOS x64/arm64 and Linux x64 with glibc `>=2.17`; Windows x64 is experimental |
| `pi-okf-search` | Node.js `>=22.19.0` and the same native platforms as `okf-search-native` |
| `okf-minisearch` | Node.js `>=20` for directory loading, or a modern browser; ESM only |

The native packages do not support browsers, Linux musl/Alpine, Linux arm64, or Windows arm64. Check the [native platform matrix](packages/okf-search-native/README.md#requirements-and-tested-platforms) before deploying.

## Browser demo

Try the [`okf-minisearch` browser demo](https://robhowley.com/okf-search/). It searches a sample corpus and validates selected Markdown entirely in memory.

## Development

The full workspace requires Node.js `>=22.19.0`, pnpm `11.22.0`, and Rust `1.88.0`.

```sh
pnpm install
pnpm package:check
```

`pnpm package:check` performs the full build, Rust checks, type checks, tests, and packed-package consumer checks.

Build and test one package with pnpm filters:

```sh
pnpm --filter okf-search-native build
pnpm --filter okf-search-native test
pnpm --filter okf-minisearch test
pnpm --filter pi-okf-search test
```

Run the Pi extension from this checkout after building the native backend:

```sh
pnpm --filter okf-search-native build
pi -e ./packages/pi-okf-search/extensions/okf-search/index.ts
```

## Learn about OKF

- [OKF v0.2 specification](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/ad30107c31c06aec8a7d5636e0d1058118604e6f/SPEC.md)
- [`okf-search-native` documentation](packages/okf-search-native/README.md)
- [`pi-okf-search` documentation](packages/pi-okf-search/README.md)
- [`okf-minisearch` documentation](packages/okf-minisearch/README.md)

## License

Released under the [MIT License](LICENSE).
