# `okf-search-native`

Search [Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/open-knowledge-format)
Markdown collections at native speed from Node.js, powered by Rust and Tantivy.
The native backend defaults to in-memory indexes and can opt into private mmap
backing for root-directory opens. Get the best matching section from each
document, with its source path, line numbers, and snippet.

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

## Open and reuse an index

Without options, `openOkf` reads and indexes the collection in memory. The
handle does not watch files or write source files. Without a cache, call
`openOkf` again to pick up source filesystem changes. Close every handle from a
`finally` block; `close()` releases resources without saving.

To reuse a native snapshot across processes, pass a filesystem `cachePath`:

```js
import { openOkf } from "okf-search-native";

const cachePath = "./.cache/knowledge.okf";
const index = await openOkf("./knowledge", { cachePath });

index.ingest({
  path: "runbooks/new.md",
  markdown: "---\ntype: runbook\n---\nNew material.\n",
});
await index.save(cachePath);
```

- **First open:** a missing cache is built from `root`; parent directories are
  created, and the complete cache is published before `openOkf` resolves.
- **Later open:** an existing cache is loaded without reading or requiring
  `root`; saved document paths stay unchanged.
- **Failures:** an existing directory, dangling link, unreadable, corrupt, or
  incompatible cache destination rejects instead of silently rebuilding from
  `root`. Damaged contents report `ERR_OKF_CACHE_INVALID`; unsupported cache
  metadata reports `ERR_OKF_CACHE_INCOMPATIBLE`.
- **No cache:** without `cachePath`, the handle stays in memory and creates no
  cache artifacts. `cachePath` is a cache-file path, not a Markdown identity.
- **Mapped mode:** pass `{ cachePath, storage: "mmap" }` to use a private
  Tantivy `MmapDirectory`. `cachePath` is required, the archive remains an
  ordinary snapshot file, and invalid options or mmap initialization failures
  never fall back to memory. Each handle extracts its own private workspace;
  replacing the archive does not refresh an already-open handle.

For a mapped root open, close the handle explicitly:

```js
const mapped = await openOkf("./knowledge", {
  cachePath: "./.cache/knowledge.okf",
  storage: "mmap",
});
try {
  console.log(mapped.search("rollback deployment"));
} finally {
  await mapped.close();
}
```

`openOkf` recursively reads lowercase `.md` files, excluding files named exactly
`index.md` or `log.md`. See the [persistence contract](https://github.com/robhowley/okf-search/blob/main/packages/okf-search-native/API.md#persistence)
for writer exclusion, snapshot timing, and filesystem caveats.

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

## Save a snapshot

`save(path)` explicitly writes the current handle state. It is available on
handles from both `openOkf` and `createOkfSearch`:

```js
import { createOkfSearch } from "okf-search-native";

const index = createOkfSearch([
  { path: "notes/one.md", markdown: "---\ntype: note\n---\nOne.\n" },
]);

await index.save("./.cache/notes.okf");
```

`save` captures one consistent snapshot before returning its promise and
resolves after atomic publication. Mmap capture copies committed Tantivy files
synchronously on the calling thread, so `save()` can block before its first
`await`. Mutations made after capture require another save. Concurrent saves on
one handle reject, and concurrent writers to one destination reject with
`ERR_OKF_CACHE_BUSY`; independent handles are not merged. A stale handle can
replace a destination with its older full snapshot. A failed save does not
replace a previous complete cache or poison a healthy handle. See the [full
persistence contract](https://github.com/robhowley/okf-search/blob/main/packages/okf-search-native/API.md#persistence)
for locking, reader visibility, close, and filesystem caveats.

`close()` never saves. If it begins while a save is accepted, it drains that
save before releasing resources. Save publication and close cleanup have
independent outcomes. A successful mapped close removes its private temporary
workspace. If shutdown is uncertain, or removal fails after quiescence,
`close()` rejects with `ERR_OKF_CLOSE` and reports the retained path. Verify no
process uses that path before removing it manually. Mapped workspaces can
contain plaintext index data and use disk space in addition to the portable
cache and temporary save files.

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

`indexStats().storage.sizeInBytes` is a sampled backing-file metric, not RSS.
For mmap it sums regular files in that handle's private workspace, including
management, temporary, lock, and obsolete files that are present during the
scan. It is not an exact committed-generation size or mapped-page count.

## Performance benchmarks

Measured on 13,692 Markdown documents (59.57 MiB of source text), using the public
`openOkf` and `search` APIs.

### Default search options

Fuzzy matching is disabled by default; final-term prefix matching remains enabled.

| Metric | [okf-minisearch][benchmark-minisearch] | [okf-search-native][benchmark-native] |
| --- | ---: | ---: |
| Median `openOkf` time | 20.40 s | 1.57 s |
| Warm query p50 | 10.45 ms | 1.38 ms |
| Warm query p95 | 86.81 ms | 2.38 ms |
| Warm query p99 | 95.64 ms | 2.45 ms |
| Reported index storage¹ | 200.37 MiB | 80.75 MiB |
| Median post-open RSS | 2,235 MiB | 527 MiB |

The native benchmark uses the default in-memory backend and makes no mmap
performance or RSS promise.

### Fuzzy matching enabled

The same queries and defaults, changing only the search call to:

```ts
index.search(query, { fuzzy: true });
```

| Metric | [okf-minisearch][benchmark-minisearch] | [okf-search-native][benchmark-native] |
| --- | ---: | ---: |
| Warm query p50 | 14.36 ms | 7.96 ms |
| Warm query p95 | 87.36 ms | 14.12 ms |
| Warm query p99 | 96.71 ms | 15.00 ms |

¹ MiniSearch reports serialized JSON bytes; native reports in-memory Tantivy
index-file bytes. These are different storage representations, not equivalent RAM
measurements. Native storage can vary with background merges.

[benchmark-minisearch]: https://github.com/robhowley/okf-search/blob/31d5da38d9502a85101c670729ca1a9646ad3a32/packages/okf-minisearch/package.json
[benchmark-native]: https://github.com/robhowley/okf-search/blob/c187a764b10682919805714faf51d54bf53eb133/packages/okf-search-native/package.json

## Reference and development

- [API reference](https://github.com/robhowley/okf-search/blob/main/packages/okf-search-native/API.md): options, return values, errors, and index statistics.
- [Prepared API](https://github.com/robhowley/okf-search/blob/main/packages/okf-search-native/API.md#advanced-prepared-api): for applications that already produce prepared documents.
- [Backend differences](https://github.com/robhowley/okf-search/blob/main/packages/okf-search-native/API.md#backend-differences): Tantivy ranking differs from `okf-minisearch`; `autoSuggest` is unsupported.
- Prepared constructors remain memory-only; use the package-root API with `storage: "mmap"` for mapped root-directory opens.
- [Development](https://github.com/robhowley/okf-search/blob/main/packages/okf-search-native/DEVELOPMENT.md): local builds, tests, and release artifacts.

## License

[MIT](https://github.com/robhowley/okf-search/blob/main/packages/okf-search-native/LICENSE)
