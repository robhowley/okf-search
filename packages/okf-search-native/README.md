# `okf-search-native`

Search [Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/open-knowledge-format)
collections at native speed from Node.js. `okf-search-native` builds an in-memory
index with Rust and Tantivy and returns the best matching section from each
document.

Use the package root for Markdown files or strings. Most users should start
there. Use `okf-search-native/prepared` only when your application already
produces prepared OKF documents.

## Install

```sh
npm install okf-search-native
```

The package requires Node.js `>=22.19.0` and includes TypeScript declarations.
See [Requirements and tested platforms](#requirements-and-tested-platforms) for
the available native artifacts.

## Raw Markdown API

`createOkfSearch(documents)` synchronously indexes Markdown already in memory.
`openOkf(root)` recursively reads lowercase `.md` files from a Node.js
directory. Files named exactly `index.md` or `log.md` are reserved and are not
indexed.

```js
import {
  createOkfSearch,
  openOkf,
  validateOkfDocument,
} from "okf-search-native";

const document = {
  path: "notes/memory.md",
  markdown: "---\ntype: note\n---\nMemory safety matters.\n",
};

const validation = validateOkfDocument(document);
const index = createOkfSearch([document]);
const hits = index.search("memory", { limit: 10, fields: ["body"] });
const stats = index.indexStats();

const directoryIndex = await openOkf("./knowledge");
directoryIndex.ingest({
  path: "notes/new.md",
  markdown: "---\ntype: note\n---\nNew material.\n",
});
directoryIndex.remove("notes/new.md");
```

Both constructors return an in-memory search handle. `ingest` adds or replaces
one document after successful validation. `remove` changes only the current
index, not its source file. Reopening a directory rebuilds the index from the
files on disk.

### Search behavior

Search supports any or all term matching, field selection and boosts, fuzzy
matching, final-term prefix matching, and filters for OKF type, tags, status,
trust tier, staleness, and conformance.

Results contain at most one hit per document. Each hit represents its
highest-ranked matching section and includes the document path, heading path,
line range, matched fields, and snippet. The handle also provides `listTypes()`
and `listDegradedDocuments()` for inspecting the current collection.

`indexStats()` returns committed logical counts and native index-file telemetry.
For this backend, `stats.storage.indexFileBytes` is the current sum of Tantivy
`RamDirectory` file lengths; it is not total process memory and can change after
merges or removals. The returned stats snapshot is detached and recursively
frozen.

### Validation

`validateOkfDocument` checks one Markdown document without changing an index.
A strict document is valid and indexable. A degraded document remains indexable
and searchable, with diagnostics describing fields that need repair. A document
with a fatal path, parsing, Markdown, or `type` problem is not indexable.
Expected validation failures are returned as diagnostics rather than thrown.

See the [OKF v0.2 specification](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/ad30107c31c06aec8a7d5636e0d1058118604e6f/SPEC.md)
for the document format and field semantics.

### Differences from `okf-minisearch`

The native backend uses Tantivy, so its ranking, scores, snippets, and fuzzy
candidates can differ from `okf-minisearch`. Browser use is not supported.
`autoSuggest` is also unsupported and throws an `OkfError` with code
`ERR_OKF_UNSUPPORTED`.

## Prepared API

Most users can skip this section. Use the prepared API when another part of
your application already produces `PreparedDocument` values and you want to
pass them directly to the native backend.

```js
import { NativeOkfSearch } from "okf-search-native/prepared";

const index = NativeOkfSearch.fromPrepared(preparedDocuments);
const hits = index.search("memory", { limit: 10, fields: ["body"] });
const stats = index.indexStats();
index.ingestPrepared(preparedDocument);
index.removeDocument("docs/old");
```

`fromPrepared` builds an index from prepared documents. `ingestPrepared`
replaces every indexed section owned by one document, and `removeDocument`
removes them together. `PreparedDocument` contains document-wide metadata once;
each `PreparedSection` contains only its ID, heading path, text, and line
bounds. The DTO declarations are exported from `okf-search-native/prepared`,
not from the package root.

## Requirements and tested platforms

Linux x64 and macOS x64/arm64 are fully supported. Windows x64 is experimental.
All targets require Node.js `>=22.19.0` and use Node-API 8.

| Platform | Native artifact |
| --- | --- |
| macOS x64 | `okf-search-native.darwin-x64.node` |
| macOS arm64 | `okf-search-native.darwin-arm64.node` |
| Windows x64 (MSVC) | `okf-search-native.win32-x64-msvc.node` |
| Linux x64 (glibc >= 2.17) | `okf-search-native.linux-x64-gnu.node` |

Linux musl/Alpine, Linux arm64, Windows arm64, Bun, Deno, browsers, and other
Node versions are not covered by this matrix.

## Development

Development requires Rust `1.88.0`:

```sh
pnpm install
pnpm --filter okf-search-native run build
pnpm --filter okf-search-native run check:rust
pnpm --filter okf-search-native run test
```

### Build output

`napi build` generates `native.cjs`, `native.d.cts`, and the host `.node`
artifact. The package facade build writes `dist/index.cjs`, `dist/index.mjs`,
`dist/index.d.cts`, `dist/index.d.mts`, and `dist/index.d.ts`. Generated native
loader names are internal and are not package-root exports.

### Release artifacts

For multi-target candidate assembly, copy the four tested `.node` files into
the package root, then run `pnpm run verify:release-artifacts`. The verifier
derives the required artifact names from the checked-in target list and
rejects missing or extra native files. CI also uses its `glibc <artifact>` mode
to reject Linux addons that import symbols newer than `GLIBC_2.17`.

## License

[MIT](../../LICENSE)
