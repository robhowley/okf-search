# `okf-search-native`

Search [Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/open-knowledge-format)
Markdown collections at native speed from Node.js, powered by Rust and Tantivy.
Get the best matching section from each document, with its source path, line
numbers, and snippet.

## Install

```sh
npm install okf-search-native
```

Requires Node.js `>=22.19.0`. Includes TypeScript declarations and native
binaries for macOS x64/arm64 and Linux x64 (glibc >= 2.17); Windows x64 is
experimental. Browsers and Alpine/musl are not supported.
See the [full platform list](https://github.com/robhowley/okf-search/blob/main/packages/okf-search-native/API.md#requirements-and-tested-platforms).

## Search a collection

Given a directory of OKF Markdown files at `./knowledge`:

```js
import { openOkf } from "okf-search-native";

const index = await openOkf("./knowledge");
const hits = index.search("rollback deployment");

for (const hit of hits) {
  console.log(hit.path, hit.headingPath, hit.snippet);
}
```

To try this with one document, save the following as
`knowledge/runbooks/deployment.md` before running the example:

```markdown
---
type: runbook
---
# Deployment

## Rollback

To rollback a deployment, restore the previous release and check service health.
```

The result points to the rollback section (selected fields shown):

```js
{
  path: "runbooks/deployment.md",
  headingPath: "Deployment > Rollback",
  startLine: 6,
  endLine: 8,
  snippet: "To rollback a deployment, restore the previous release and check service health."
}
```

Use the path and line numbers to open the source, and the heading and snippet
to display a preview. Results contain at most one hit per document, ordered by
relevance. See the [complete result shape](https://github.com/robhowley/okf-search/blob/main/packages/okf-search-native/API.md#results).

**Open once and reuse the handle.** Opening reads and indexes the collection
into memory; every new `openOkf` call rebuilds it. The handle does not watch
files, write changes to disk, or persist the index. Reopen to pick up filesystem
changes.

`openOkf` recursively reads lowercase `.md` files, excluding files named exactly
`index.md` or `log.md`.

## Already have Markdown strings?

Use `createOkfSearch` instead of reading a directory. It builds the same kind
of handle synchronously:

```js
import { createOkfSearch } from "okf-search-native";

const index = createOkfSearch([{
  path: "runbooks/deployment.md",
  markdown: "---\ntype: runbook\n---\nTo rollback a deployment, restore the previous release.\n",
}]);

const hits = index.search("rollback deployment");
```

## Refine a search

Require all query terms and restrict results to runbooks:

```js
index.search("rollback deployment", {
  match: "all",
  where: { types: ["runbook"] },
});
```

Enable typo tolerance:

```js
index.search("deploymnt", { fuzzy: true });
```

By default, searches return up to ten documents, match any query term across
all searchable fields, and disable fuzzy matching. The final term still
matches prefixes when it has at least three characters: `"deploy"` can match
`"deployment"`, even with `fuzzy: false`.

Use `limit` to change the result count and `fields` to restrict where terms
match. Filters also support tags, status, trust tier, staleness, and conformance.
See [search options and defaults](https://github.com/robhowley/okf-search/blob/main/packages/okf-search-native/API.md#search)
for field boosts, filter combinations, and detailed matching rules.

## Update the in-memory index

`ingest` adds a document or replaces the document with the same path. `remove`
returns whether the document was present. Neither operation changes files:

```js
index.ingest({
  path: "runbooks/restart.md",
  markdown: "---\ntype: runbook\n---\nRestart the service after draining active requests.\n",
});

index.remove("runbooks/restart.md");
```

Use relative `.md` paths, such as `runbooks/restart.md`. If preparation of a
replacement fails, the existing document remains searchable.
See [update results and path rules](https://github.com/robhowley/okf-search/blob/main/packages/okf-search-native/API.md#update-and-reuse-the-handle).

## Check documents and handle failures

Documents with valid OKF metadata are **strict**. Some metadata problems make
a document **degraded**: it remains searchable, with diagnostics explaining
what needs repair. Fatal problems, such as missing required `type` metadata,
prevent indexing.

Constructors and `ingest` validate automatically. To inspect diagnostics before
indexing, use `validateOkfDocument`:

```js
import { validateOkfDocument } from "okf-search-native";

const input = {
  path: "runbooks/draft.md",
  markdown: "---\ntype: runbook\nstatus: not-a-status\n---\nDraft deployment instructions.\n",
};
const validation = validateOkfDocument(input);

for (const { path, field, message } of validation.errors) {
  console.warn(path, field, message);
}

if (validation.isIndexable) {
  index.ingest(input); // Degraded documents can still be indexed.
}
```

Validation returns expected document problems as diagnostics. Indexing rejects
fatal document problems with `OkfError`; `openOkf` also rejects unreadable
files. Invalid search options throw `TypeError`. An `ERR_OKF_INDEX_UNUSABLE`
error means the handle must be rebuilt, not retried.
See [validation outcomes and error handling](https://github.com/robhowley/okf-search/blob/main/packages/okf-search-native/API.md#validation-and-failures).

To inspect an existing collection:

```js
console.log(index.indexStats().logical.documents.total);
console.log(index.listTypes());
console.log(index.listDegradedDocuments());
```

## Performance benchmarks

On a private `wiki-w-type` collection of 13,692 Markdown documents (59.57 MiB
of source text), native opened about **9.9× faster** and used **79% less
post-open resident memory** in this benchmark.

| Metric | [okf-minisearch 2.3.0][benchmark-minisearch] | [okf-search-native 0.5.1][benchmark-native] |
| --- | ---: | ---: |
| Median `openOkf` time | 21.85 s | 2.21 s |
| Warm query p50 | 11.05 ms | 1.33 ms |
| Warm query p95 | 87.02 ms | 2.32 ms |
| Median post-open RSS | 2,417 MiB | 502 MiB |
| Median peak RSS | 3,138 MiB | 590 MiB |

[benchmark-minisearch]: https://github.com/robhowley/okf-search/blob/db885cb850e986e99bd9f5117e390d89ea9cf90c/packages/okf-minisearch/package.json
[benchmark-native]: https://github.com/robhowley/okf-search/blob/db885cb850e986e99bd9f5117e390d89ea9cf90c/packages/okf-search-native/package.json

Measured on macOS arm64, Node.js 24.15.0, using local builds of the linked
source revisions (native in release mode).

- **Method:** five fresh processes per backend, run sequentially; nine default-option
  queries, each with 30 warmups and 200 timed calls per process. Query percentiles
  pool all samples. Open time excludes imports; filesystem caches were not cleared.
- **Memory:** RSS covers the whole process, including native allocations. Post-open
  samples follow `indexStats()` and forced GC; peak includes startup, stats, and
  searches. MiniSearch's stats serialization can increase memory usage.
- **Limits:** one private corpus, not distributed here. MiniSearch was faster on
  two queries; equivalent hits and ranking were not tested.

## Reference and development

- [API reference](https://github.com/robhowley/okf-search/blob/main/packages/okf-search-native/API.md): options, return values, errors, and index statistics.
- [Prepared API](https://github.com/robhowley/okf-search/blob/main/packages/okf-search-native/API.md#advanced-prepared-api): for applications that already produce prepared documents.
- [Backend differences](https://github.com/robhowley/okf-search/blob/main/packages/okf-search-native/API.md#backend-differences): Tantivy ranking differs from `okf-minisearch`; `autoSuggest` is unsupported.
- [Development](https://github.com/robhowley/okf-search/blob/main/packages/okf-search-native/DEVELOPMENT.md): local builds, tests, and release artifacts.

## License

[MIT](https://github.com/robhowley/okf-search/blob/main/packages/okf-search-native/LICENSE)
