# Native search API reference

Start with the [README](https://github.com/robhowley/okf-search/blob/main/packages/okf-search-native/README.md) for installation and a first search.
This reference covers the package-root API unless a section says otherwise.

## Search

`search(query, options?)` trims and tokenizes the query. Queries with no terms
return `[]`. Matching is case-insensitive for searchable text fields.

| Option | Default | Behavior |
| --- | --- | --- |
| `limit` | `10` | Maximum number of returned documents. Must be a finite, non-negative integer; `0` returns `[]`. |
| `snippetLength` | `240` | Maximum UTF-8 byte length of the section text window. Must be a finite positive integer; ellipsis overhead is excluded. |
| `match` | `"any"` | `"any"` matches at least one query term; `"all"` requires every term across the selected fields of one section. |
| `fields` | All eight fields | Search `resource`, `title`, `heading`, `description`, `tags`, `type`, `sources`, and `body`. The array must be non-empty. |
| `boost` | See below | Set a field's ranking weight. Values must be between `0.1` and `10`, inclusive. |
| `fuzzy` | `false` | `true` uses ratio `0.2`; a number may be any finite value from `0` to `1`. |
| `where` | No filters | Filter by metadata, staleness, or conformance. Multiple filter properties are combined. |
| `asOf` | Current time | The `Date` used to evaluate `where.stale`. |

Default boosts: `resource: 6`, `title: 5`, `heading: 4`, `description: 3`,
`tags: 2`, `type: 1.5`, `sources: 1`, `body: 1`.
Override individual weights with, for example, `boost: { body: 2 }`.

`where` supports `types`, `tagsAny`, `statuses`, `trustTiers`, `stale`, and
`conformance`. `statuses` accepts `draft`, `stable`, or `deprecated`;
`trustTiers` accepts `unverified`, `machine-confirmed`, or `human-reviewed`; and
`conformance` accepts `strict` or `degraded`.

The examples below assume an `index` created with `openOkf` or `createOkfSearch`:

```js
const filteredHits = index.search("memory safety", {
  limit: 5,
  match: "all",
  fields: ["title", "heading", "body"],
  where: {
    types: ["note"],
    stale: false,
    conformance: ["strict"],
  },
  asOf: new Date("2026-08-24T12:00:00Z"),
});
console.log(filteredHits.map(({ path, snippet }) => ({ path, snippet })));
```

Type, tag, status, trust-tier, and conformance values are exact and
case-sensitive. Values within one filter array are alternatives (OR); filter
properties are combined with AND. Empty filter arrays impose no restriction.

The final query term also gets prefix matching when it has at least three
characters. For example, `"rollback proce"` can match `procedure`; earlier
terms are never prefixes, and a one- or two-character final term is not a
prefix. This prefix behavior remains enabled when fuzzy matching is `false`.

### Staleness filter details

`stale: true` selects classified documents whose `staleAfter` is at or before
`asOf`. `stale: false` selects classified documents that are not stale at
`asOf`; a classified document without a stale deadline matches this branch.
Unclassified degraded documents match neither staleness branch.


### Fuzzy edit-distance details

With fuzzy matching enabled, the backend adds edit-distance candidates. A
numeric `fuzzy` value is a ratio: the allowed distance is rounded from
`termLength * ratio` and clamped to one or two edits. `fuzzy: false` and
`fuzzy: 0` disable those edit-distance candidates but do not disable final-term
prefix matching. When fuzzy matching is enabled, the final-term prefix query
uses the same edit distance.


### Results

Search returns `OkfSearchHit[]`, with at most one hit per document. Each hit
represents the highest-ranked matching section and has this shape:

```ts
{
  documentId: string;
  title: string;
  sectionId: string;
  score: number;
  conformance: "strict" | "degraded";
  matchedFields: OkfSearchField[];
  headingPath: string;
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
}
```

`matchedFields` lists the selected fields that matched. `headingPath` and the
line bounds identify the section; `snippet` is text from that section.

## Update and reuse the handle

Use the same handle for repeated searches and updates:

```js
const result = index.ingest({
  path: "notes/new.md",
  markdown: "---\ntype: note\n---\nNew material.\n",
});

if (result.conformance === "strict") {
  console.log(result.document.id);
} else {
  console.warn(result.documentId, result.path, result.diagnostics);
}

const removed = index.remove("notes/new.md");
console.log(removed); // true when the document was present
```

`ingest` adds or replaces one document after successful preparation. A strict
result is `{ conformance: "strict", document }`; a degraded result is
`{ conformance: "degraded", documentId, path, diagnostics }`. Both operations
use a relative POSIX path ending in lowercase `.md`. `remove` returns a boolean
and normalizes its path the same way.

### Path normalization and rejection rules

Paths are logical identities, not filesystem lookups. The normalizer:

- removes internal empty and exact `.` segments;
- preserves case and literal backslashes;
- rejects empty or dot-only paths, POSIX absolute paths, drive-prefixed or
  UNC-looking paths, every exact `..` segment, and trailing `/` or `/.`;
- requires the final component to end in lowercase `.md` and not be exactly
  `index.md` or `log.md`;
- removes `.md` from the normalized path to form the document ID.

These checks happen before Markdown parsing or index mutation. The normalized
path is used for document and record IDs, stored/search-hit paths, replacement
lookup, and later parse diagnostics. Metadata and body-link values are inert;
for example, `resource: ../target` is accepted as data.


The index never writes source files or watches the directory. `remove` changes
only the current handle. Without a cache path, `openOkf` keeps the index in
memory and creates no cache artifacts; call it again to pick up source
filesystem changes. A preparation failure in `ingest` leaves an existing
document unchanged, so a corrected replacement can be retried on the same
usable handle.

## Persistence

Persistence is opt-in. Use `cachePath` when opening a directory and
`save(path)` when publishing a handle snapshot. These are filesystem paths;
document `path` values remain logical identities.

### Open with a cache

```js
import { openOkf } from "okf-search-native";

const cachePath = "./.cache/knowledge.okf";
const index = await openOkf("./knowledge", { cachePath });
```

`openOkf(root, options?)` accepts:

```ts
interface OkfOpenOptions {
  readonly cachePath?: string;
}
```

- **Cache hit:** an existing cache is loaded directly. The source `root` is not
  accessed, does not need to exist, and is not used to rebase saved identities.
- **Cache miss:** only a genuinely missing destination counts as a miss. Parent
  directories are created, the collection is built from `root`, and the
  complete cache is published before `openOkf` resolves.
- **Reject:** existing directories, dangling links, corrupt or incompatible
  files, and other read failures reject instead of triggering a hidden rebuild.
- **Compatibility:** cache metadata records the supported format, schema,
  analyzer, preparation, and Tantivy compatibility revisions. Unsupported
  metadata reports `ERR_OKF_CACHE_INCOMPATIBLE`; damaged contents report
  `ERR_OKF_CACHE_INVALID`.

A missing-cache open takes the same sibling writer lock as `save`. If another
writer holds that destination claim, it rejects with `ERR_OKF_CACHE_BUSY` rather
than waiting.

### Save a handle snapshot

`OkfSearch.save(path): Promise<void>` is available on package-root handles from
both `openOkf` and `createOkfSearch`. The prepared `NativeOkfSearch` handle
exported from `okf-search-native/prepared` exposes the same method.

```js
import { createOkfSearch } from "okf-search-native";

const index = createOkfSearch([
  { path: "notes/one.md", markdown: "---\ntype: note\n---\nOne.\n" },
]);

index.ingest({
  path: "notes/new.md",
  markdown: "---\ntype: note\n---\nNew material.\n",
});
await index.save("./.cache/notes.okf");
```

- `save` takes a snapshot when called. Later changes need another save.
- `await save(path)` waits until the cache file has been replaced.
- Only one save can write a path at a time; others fail with
  `ERR_OKF_CACHE_BUSY`. Separate indexes are not merged.
- If saving fails, the old cache and a healthy index remain usable.

### Cache files and safety

The cache is one file. On a local filesystem, readers see the complete old or
new file—never a partly written one. This does not guarantee recovery after
power loss or safe writes on network filesystems.

Saving also creates files beside the cache:

- `.<basename>.okf-lock` prevents simultaneous writes. Leave it in place;
  loading or copying the cache does not require it.
- Temporary files are normally removed. If the process is killed, they may
  need manual cleanup.

## Validation and failures

`validateOkfDocument` returns diagnostics without changing an index:

```js
import { validateOkfDocument } from "okf-search-native";

const input = {
  path: "draft.md",
  markdown: "---\ntype: note\nstatus: not-a-status\n---\nDraft\n",
};
const validation = validateOkfDocument(input);

for (const diagnostic of validation.errors) {
  console.error(
    `${diagnostic.code} ${diagnostic.path}` +
      (diagnostic.field ? ` (${diagnostic.field})` : "") +
      `: ${diagnostic.message}`,
  );
}

if (validation.isIndexable) {
  index.ingest(input);
}
```

The exported [`OkfValidationResult`](https://github.com/robhowley/okf-search/blob/main/packages/okf-search-native/src/types.ts#L105-L120)
discriminates these outcomes; each error uses the exported
[`OkfDiagnostic`](https://github.com/robhowley/okf-search/blob/main/packages/okf-search-native/src/types.ts#L98-L103) type.

- Strict input returns `isValid: true`, `isIndexable: true`, and no errors.
- Degraded input returns `isValid: false`, `isIndexable: true`, and diagnostics;
  it remains searchable.
- Fatal path, parsing, Markdown, or required `type` problems return
  `isIndexable: false` and must be fixed before indexing.

See the [OKF v0.2 specification](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/ad30107c31c06aec8a7d5636e0d1058118604e6f/SPEC.md)
for the document format and field semantics.

Expected preparation failures from `createOkfSearch` or `ingest` throw
`OkfError`. A failed constructor returns no handle; a failed preparation during
`ingest` leaves the handle usable:

```js
import { OkfError } from "okf-search-native";

try {
  index.ingest({ path: "broken.md", markdown: "not frontmatter" });
} catch (error) {
  if (
    error instanceof OkfError &&
    (error.code === "ERR_OKF_PARSE" || error.code === "ERR_OKF_FIELD")
  ) {
    console.error({
      code: error.code,
      path: error.path,
      field: error.field,
      message: error.message,
    });
    // Correct the Markdown or field and call index.ingest(...) again.
  } else {
    throw error;
  }
}
```

### Error codes

| Code | Meaning |
| --- | --- |
| `ERR_OKF_READ` | A source or cache path could not be read, or an existing cache destination is not a regular file. |
| `ERR_OKF_PARSE` | Markdown or document preparation failed. |
| `ERR_OKF_FIELD` | An input field or cache path is invalid. |
| `ERR_OKF_CACHE_INVALID` | Cache contents are damaged or fail cache-internal validation. |
| `ERR_OKF_CACHE_INCOMPATIBLE` | The cache format or compatibility revisions are unsupported. |
| `ERR_OKF_WRITE` | Cache publication or another cache filesystem write failed. |
| `ERR_OKF_CACHE_BUSY` | Another writer holds the destination lock. |
| `ERR_OKF_INDEX_UNUSABLE` | A native mutation failed; rebuild the handle. |
| `ERR_OKF_UNSUPPORTED` | The requested operation is not supported by this backend. |

Filesystem failures report the relevant path and, when available, a `cause`.
Cache I/O, format, and lock failures report the supplied cache destination in
`path`. Invalid cache paths use `ERR_OKF_FIELD` with `field: "cachePath"` for
`openOkf` and `field: "path"` for `save`. Invalid search options are
`TypeError`, not `OkfError`; for example, `search("x", { limit: -1 })` reports
that `options.limit` must be a finite non-negative integer. If a native
mutation failure makes a handle unusable, subsequent calls report
`ERR_OKF_INDEX_UNUSABLE`; rebuild the handle from the source documents.

## Inspect the collection

```js
console.log(index.listTypes());
console.log(index.listDegradedDocuments());
console.log(index.indexStats());
```

`listTypes()` returns sorted type names. `listDegradedDocuments()` returns
sorted `{ documentId, path, diagnostics }` entries. `indexStats()` returns a
detached, recursively frozen snapshot from a package-root handle:

### Full `OkfIndexStats` return shape

```ts
{
  logical: {
    documents: {
      total: number;
      strict: number;
      degraded: number;
    };
    types: readonly {
      type: string;
      documentCount: number;
    }[];
    statuses: {
      draft: number;
      stable: number;
      deprecated: number;
      unclassified: number;
    };
    trustTiers: {
      unverified: number;
      machineConfirmed: number;
      humanReviewed: number;
      unclassified: number;
    };
  };
  storage: {
    kind: "in-memory-index-files";
    sizeInBytes: number;
  };
}
```


Logical values count documents, not sections, and change only after a
successful `ingest` or `remove`. `types` preserves case and is sorted by type.
Missing effective status or trust-tier metadata counts as `unclassified`.
`sizeInBytes` samples the handle's Tantivy `RamDirectory`; it excludes other
process memory and can change without a logical change.

## Advanced: prepared API

Use the prepared API when your application already has `PreparedDocument`
values and wants to pass them directly to the native backend:

```js
import { NativeOkfSearch } from "okf-search-native/prepared";

// These values come from your existing preparation pipeline.
const index = NativeOkfSearch.fromPrepared(preparedDocuments);
const hits = index.search("memory", { limit: 10, fields: ["body"] });
index.ingestPrepared(preparedDocument); // replaces that document's sections
index.removeDocument("docs/old"); // takes a document ID, not a path
```

`PreparedDocument` contains document-wide metadata once. Each
`PreparedSection` contains its ID, heading path, text, and line bounds. The
complete DTO declarations are published in [`native.d.cts`](https://github.com/robhowley/okf-search/blob/main/packages/okf-search-native/native.d.cts) and
are exported from `okf-search-native/prepared`, not from the package root.
`ingestPrepared` returns `void`; `removeDocument` returns whether the document
ID was present. The prepared API's `indexStats()` has the same shape above but
returns a mutable N-API DTO; the package-root adapter returns the frozen copy.

## Backend differences

The native backend uses Tantivy, so its ranking, scores, snippets, and fuzzy
candidates can differ from `okf-minisearch`. Browser use is not supported.
`autoSuggest` is also unsupported and the package-root handle throws an
`OkfError` with code `ERR_OKF_UNSUPPORTED`.

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

