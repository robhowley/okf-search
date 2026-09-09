# okf-minisearch

Search [Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/open-knowledge-format) Markdown in Node.js or a browser without running a separate search service. `okf-minisearch` loads documents into an in-memory [MiniSearch](https://lucaong.github.io/minisearch/) index and returns the most relevant section from each matching document.

## Install

```sh
npm install okf-minisearch
```

The package is ESM-only and includes TypeScript declarations. Loading a directory requires Node.js 20 or newer.

## Quick start

Create an OKF concept such as `knowledge/database-rollback.md`:

```md
---
type: runbook
title: Database rollback
tags: [database, operations]
status: stable
verified:
  - by: human:alice
    at: 2026-08-24T10:00:00Z
---
# Before you start

Confirm that a recent backup is available.

# Roll back

Restore the last known-good snapshot, then verify application health.
```

Open the directory and search it:

```js
import { openOkf } from "okf-minisearch";

const okf = await openOkf("./knowledge");
const hits = okf.search("rollback snapshot");

for (const hit of hits) {
  console.log(hit.path, hit.headingPath, hit.snippet);
}
```

In Node.js, `openOkf(root)` recursively reads regular `.md` files. Files named exactly `index.md` or `log.md` are reserved and are not indexed.

See [Accepted OKF documents](#accepted-okf-documents).

Using Rollup for Node? Add `"node"` to `@rollup/plugin-node-resolve`'s `exportConditions`.

## Browser

Use the package-root `openOkf` with files selected in the browser. Pass a `FileList` or `File[]`, not a local path string. For a directory selection, add `webkitdirectory`:

```html
<input id="knowledge" type="file" accept=".md" multiple webkitdirectory>
```

```js
import { openOkf } from "okf-minisearch";

const input = document.querySelector("#knowledge");
input.addEventListener("change", async () => {
  if (!input.files) return;

  const okf = await openOkf(input.files);
  console.log(okf.search("rollback snapshot"));
});
```

Without a bundler, load the browser API from a CDN:

```html
<script src="https://cdn.jsdelivr.net/npm/okf-minisearch@2"></script>
<script>
  const { createOkfSearch, openOkf } = OkfMiniSearch;
</script>
```

Only filenames ending in lowercase `.md` are indexed. Files named exactly `index.md` or `log.md` are ignored.

## Preloaded Markdown

When Markdown is already in memory, use `createOkfSearch` for synchronous construction in Node.js or a browser:

```js
import { createOkfSearch } from "okf-minisearch";

const markdown = `---
type: guide
title: Recovery guide
---
# Recovery

Restart the worker and inspect its health check.
`;

const okf = createOkfSearch([
  { path: "guides/recovery.md", markdown },
]);

console.log(okf.search("health check"));
```

Each item needs a relative `.md` `path` and its Markdown string in `markdown`. The Markdown must have parseable frontmatter with a nonblank `type`.

## Search

Pass options to control query matching, searchable fields, metadata filters, and result limits:

```js
const hits = okf.search("rollback snapshot", {
  match: "all",
  fields: ["title", "body"],
  boost: { title: 8 },
  fuzzy: 0.2,
  limit: 5,
  where: {
    types: ["runbook"],
    tagsAny: ["database", "storage"],
    statuses: ["stable"],
    trustTiers: ["human-reviewed"],
    conformance: ["strict"],
    stale: false,
  },
  asOf: new Date("2026-08-24T12:00:00Z"),
});
```

### Query options

| Option | Behavior |
| --- | --- |
| `limit` | Maximum returned documents. Defaults to `10`; `0` returns no hits. |
| `match` | `"any"` (the default) matches any query term. `"all"` requires every term to match the same indexed section or chunk, though terms may match different fields within it. |
| `fields` | Non-empty readonly list of fields to search. Omission searches every public field listed below. |
| `fuzzy` | Enables typo-tolerant matching with `true` or a number from `0` through `1`. Omission, `false`, and `0` disable it. |
| `boost` | Changes how strongly matches in each selected field affect ranking. |

`boost` values replace the default weights—not multiply them—and must be between `0.1` and `10`. Omitted fields keep the defaults listed below. Use `fields` to choose which fields are searched.

The final query term receives prefix matching when it has at least three characters. This remains active with fuzzy matching, so earlier terms can use fuzzy matching while the final term uses prefix matching.

`fuzzy: true` is equivalent to `fuzzy: 0.2`. Fractional values use a term-length ratio; `1` allows one character edit. Higher values may also match unrelated words with similar spelling.

### Filters

All `where` filters are combined with AND. Values within a filter array are combined with OR. Omitted filters and empty arrays are ignored.

| Filter | Matches |
| --- | --- |
| `where.types` | Frontmatter `type` values. Directory names do not define type. |
| `where.tagsAny` | Documents containing at least one listed tag. |
| `where.statuses` | `draft`, `stable`, or `deprecated`. |
| `where.trustTiers` | `unverified`, `machine-confirmed`, or `human-reviewed`. |
| `where.conformance` | Documents that are `strict` or `degraded`. |
| `where.stale` | Whether `stale_after` is at or before `asOf`. |
| `asOf` | Reference time for stale filtering. Defaults to the current time. |

### List types

Use `listTypes()` to get the document types in the current index:

```js
const types = okf.listTypes();
const hits = okf.search("rollback", {
  where: { types },
});
```

The returned array is a frozen, sorted snapshot. Values preserve case and include custom types from both strict and degraded documents.

### Index statistics

`indexStats()` returns a detached, recursively frozen snapshot:

```text
{
  logical: {
    documents: { total, strict, degraded },
    types: [{ type, documentCount }],
    statuses: { draft, stable, deprecated, unclassified },
    trustTiers: {
      unverified,
      machineConfirmed,
      humanReviewed,
      unclassified,
    },
  },
  storage: { kind: "unavailable" },
}
```

Logical values count documents, not sections, and change only after a successful `ingest` or `remove`. `types` preserves case and is sorted by type. Missing effective status or trust-tier metadata counts as `unclassified`.

### Search fields

| Public field | Indexed content | Default weight |
| --- | --- | :---: |
| `resource` | Document resource | 6 |
| `title` | Document title | 5 |
| `heading` | Section heading path | 4 |
| `description` | Document description | 3 |
| `tags` | Document tags | 2 |
| `type` | Document type | 1.5 |
| `sources` | Source IDs, titles, authors, and resources | 1 |
| `body` | Section or chunk body text | 1 |

`fields` and `boost` accept only the names above. Boosting a field does not make it searchable when it is excluded by `fields`; `where` filters remain independent.

### Results

Search returns at most one hit per document: its highest-ranked matching section or chunk. Hits are ordered by descending score. Exact score ties put strict documents before degraded documents, then use deterministic section-ID ordering.

```ts
interface OkfSearchHit {
  documentId: string;
  title: string;
  sectionId: string;
  score: number;
  conformance: OkfConformance;
  matchedFields: OkfSearchField[];
  headingPath: string;
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
}
```

Details worth knowing:

- `documentId` is the normalized relative Markdown path without `.md`.
- `title` is the frontmatter title. If omitted, it is derived from the final filename segment: hyphens and underscores become spaces, and the first character is capitalized (`nested/derived-title.md` → `Derived title`).
- `sectionId` identifies the indexed section or chunk and may change when headings or chunk boundaries change.
- `score` is meaningful only within one search; changing boosts can change document ordering and the section chosen to represent each document.
- `conformance` reports whether the indexed document is `strict` or `degraded`.
- `matchedFields` contains unique public field names in first-match order.

Degraded documents are searched by default and do not receive a general score penalty. A stronger degraded match ranks above a weaker strict match; strict wins only when scores are exactly equal. Trust tiers and conformance change which documents are included only when used as filters.

## Auto-suggest

Use `autoSuggest` to complete a partial query from terms in the current index:

```js
const suggestions = okf.autoSuggest("roll sna", {
  where: { types: ["runbook"] },
  limit: 5,
});

for (const { suggestion } of suggestions) {
  console.log(suggestion);
}
```

`autoSuggest` accepts the same options as [`search`](#query-options), including field selection, boosts, fuzzy matching, metadata filters, and stale filtering.

The important differences from `search` are:

| Behavior | `autoSuggest` | `search` |
| --- | --- | --- |
| Query matching | All terms must match | Any term may match |
| Field weights | All searched fields are equal | Uses the [default OKF weights](#search-fields) |
| Final term | Prefix-matched at any length | Prefix-matched from three characters |
| Results | Completed phrases | One hit per document |

Both methods default to 10 results with fuzzy matching disabled.

Each suggestion contains:

```ts
interface OkfSuggestion {
  readonly suggestion: string;
  readonly terms: readonly string[];
  readonly score: number;
}
```

`suggestion` is the completed phrase. `terms` contains the completed indexed terms, which may differ from the query when prefix or fuzzy matching is used. `score` ranks suggestions within the current call; do not compare scores across queries or indexes.

Duplicate completed phrases are grouped into one suggestion. Metadata filters are applied before grouping.

## Validate a document

Use `validateOkfDocument` to check in-memory Markdown without opening a directory or changing an index:

```js
import { validateOkfDocument } from "okf-minisearch";

const result = validateOkfDocument({
  path: "guides/recovery.md",
  markdown,
});

if (!result.isIndexable) {
  console.error("Document cannot be indexed", result.errors);
} else if (!result.isValid) {
  console.warn("Document will be indexed as degraded", result.errors);
}
```

Use `isIndexable` to decide whether `openOkf` or `ingest` can accept the document. A valid document is strict (`isValid: true`, `isIndexable: true`). A degraded document remains searchable (`isValid: false`, `isIndexable: true`). A document with a path, parsing, Markdown, or `type` problem that prevents indexing returns `isValid: false` and `isIndexable: false`.

Expected failures return diagnostics instead of throwing. Each diagnostic has `code`, normalized or redacted `path`, optional `field`, and `message`.

`validateOkfDocument` validates one in-memory concept document against the OKF v0.2 specification. It does not validate the surrounding bundle, resolve referenced content, execute computations, or verify attestation claims.

## Add or replace a document

Use `ingest` to add or replace one document in the current in-memory index:

```js
const result = okf.ingest({
  path: "guides/recovery.md",
  markdown: `---
type: guide
title: Recovery guide
tags: [operations]
---
# Recovery

Restart the worker and inspect its health check.
`,
});

if (result.conformance === "strict") {
  console.log(result.document.id); // guides/recovery
  console.log(result.document.status); // "stable" when status is omitted
} else {
  console.warn(result.path, result.diagnostics);
}
```

The result reports the document’s conformance:

- A strict result contains `{ conformance: "strict", document }`.
- A degraded result contains `{ conformance: "degraded", documentId, path, diagnostics }` and deliberately has no `document` property.

`path` identifies the document within the knowledge directory:

- Use a relative `.md` path with `/` between directories.
- `.` and repeated `/` segments are normalized.
- Absolute paths, parent traversal (`..`), Windows drive or UNC paths, and paths ending in `/` or `/.` are rejected.
- Files named exactly `index.md` or `log.md` are reserved.

Ingesting another path with the same normalized identity replaces the existing document, whether the new input is strict or degraded. Input that cannot be indexed throws before replacement, leaving the existing records searchable.

`ingest` changes only the current in-memory index. It does not write files, watch the filesystem, or persist the index.

## Find documents that need repair

Use `listDegradedDocuments()` after opening or updating an index:

```js
for (const item of okf.listDegradedDocuments()) {
  console.warn(item.path, item.diagnostics);
}
```

The returned list describes the current degraded documents, ordered by path. Each item contains its normalized `documentId`, path, and diagnostics. Replacing a document with strict input or removing it clears that item.

## Remove a document

Use `remove` to drop one document from the current in-memory index:

```js
const removed = okf.remove("./guides//recovery.md");
console.log(removed); // true
console.log(okf.search("worker health")); // []

console.log(okf.remove("guides/recovery.md")); // false: valid absence/repeat
console.log(okf.remove("missing.md")); // false: valid absence
```

`remove(path)` uses the same path rules as `ingest`. It removes every indexed section and chunk for that document.

- Returns `true` when the document was indexed.
- Returns `false` when the path is valid but not indexed.
- Throws `OkfError` before changing the index when the path is invalid or reserved.

Path normalization removes empty and `.` segments while preserving case and literal backslashes. Unsafe paths report `"<input>"`; invalid extensions and reserved filenames report the normalized path.

Removal affects only the current in-memory index. It does not modify the source file. Reopening the root indexes the file again.

## Accepted OKF documents

`openOkf` and `ingest` accept documents that:

- use a relative `.md` path;
- contain parseable YAML frontmatter and Markdown; and
- declare `type`, the only required frontmatter field, as a nonblank string.

The specification does not limit `type` to predefined values, so custom types are valid.

A document that follows every recognized [OKF v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/ad30107c31c06aec8a7d5636e0d1058118604e6f/SPEC.md) field rule is `strict`. Problems in other recognized fields make it `degraded` instead of rejecting it: valid values are kept, invalid values are left out of search and filters, and diagnostics explain what needs repair. Both are searched by default; degraded documents receive no general score penalty, and strict ranks first only on exact score ties.

When fields are omitted:

- the title comes from the filename;
- `status` defaults to `stable`;
- verification defaults to `unverified`; and
- the document is not stale.

A valid `human:<id>` verification means `human-reviewed`; other valid actors mean `machine-confirmed`. Defaults do not replace malformed values. Unknown frontmatter fields are accepted and retained in a strict document’s `extensions`.

## Errors

`createOkfSearch`, `openOkf`, and `ingest` throw `OkfError` when a document cannot be indexed because of its path, parsing, Markdown, or `type`. Problems in other recognized fields are accepted as degraded instead. `openOkf` also uses `OkfError` for read and UTF-8 errors, while `remove` uses it for invalid paths. `validateOkfDocument` returns document errors as diagnostics instead of throwing.

```js
import { OkfError, openOkf } from "okf-minisearch";

try {
  await openOkf("./knowledge");
} catch (error) {
  if (error instanceof OkfError) {
    console.error(error.code, error.path, error.field);
  } else {
    throw error;
  }
}
```

| Code | Meaning |
| --- | --- |
| `ERR_OKF_READ` | A selected directory or concept could not be read. |
| `ERR_OKF_PARSE` | Frontmatter, YAML, UTF-8, or Markdown could not be parsed. |
| `ERR_OKF_FIELD` | A caller-supplied path or known field is invalid. Path and `type` errors prevent indexing; other field errors can mark a document degraded. |
| `ERR_OKF_INDEX_UNUSABLE` | MiniSearch failed during an `ingest` or `remove` mutation, so the handle can no longer be used safely. |

If `ingest` or `remove` throws `ERR_OKF_INDEX_UNUSABLE`, discard the handle and rebuild it with `openOkf(root)`.

`search` and `autoSuggest` reject invalid options with `TypeError`.

## Public API

The package root exports `createOkfSearch`, `openOkf`, `validateOkfDocument`, and `OkfError`. Use `createOkfSearch(documents)` to build an `OkfSearch` synchronously from preloaded Markdown. `openOkf` builds one asynchronously from a Node directory path or browser `FileList`/`File[]`. Both return a handle with `search(query, options?)`, `autoSuggest(query, options?)`, `listTypes()`, `indexStats()`, `listDegradedDocuments()`, `ingest(input)`, and `remove(path)`. Public TypeScript types can be imported from the package root:

```ts
import type {
  OkfAutoSuggestOptions,
  OkfConformance,
  OkfDegradedDocument,
  OkfDiagnostic,
  OkfDiagnosticCode,
  OkfDocumentInput,
  OkfValidationResult,
  OkfIndexStats,
  OkfIndexStorageStats,
  OkfIngestResult,
  OkfLogicalIndexStats,
  OkfSearch,
  OkfSearchField,
  OkfSearchHit,
  OkfSearchOptions,
  OkfSuggestion,
} from "okf-minisearch";
```

See the generated declarations for the complete type surface.

## License

MIT
