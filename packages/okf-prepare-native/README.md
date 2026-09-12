# okf-prepare-native (private)

Host-native, single-document preparation and validation backed by
`crates/okf-prepare-core`. This package does not change public search routing.

```js
import { prepare, validate } from "okf-prepare-native";

prepare({ path: "notes/foo-bar.md", markdown: "---\ntype: note\n---\nBody" });
validate({ path: "notes/foo-bar.md", markdown: "---\ntype: note\n---\nBody" });
```

- `prepare` returns `kind: "fatal"` with nonempty ordered diagnostics, or
  `kind: "accepted"` with normalized identity, conformance, projected fields,
  body, body-start line, sections, and diagnostics.
- `validate` returns `{ isValid, isIndexable, errors }` from the core validator.
- Identity uses the existing TypeScript normalizer; missing titles derive from
  the final ID segment (`foo-bar` → `Foo bar`). Invalid paths are content failures.
- Malformed arguments, load failures, and unexpected native errors throw. There
  is no JavaScript preparation fallback. Only identity/error source modules are
  bundled from the TypeScript preparer; its parsers are not loaded.
- Outputs are owned objects/arrays, with absent optional own properties omitted.
  Transport field names are camelCase; timestamps remain strings and
  `staleAfter.epochMillis` is a number. Section lines are inclusive, one-based
  document lines, represented as safe JS numbers.

## Native parser contract

- Heading text comes directly from Comrak inline text, without inserted separators:
  `alpha**beta**gamma` produces `alphabetagamma` and `#alphabetagamma`.
  Native section IDs are retained; no legacy-ID lookup or routing is added.
- `endLine` is the last content line, not the empty line after a terminal newline.
  An unfinished fence on line 4 with content on line 5 ends on line 5.
- Ordinary YAML aliases are accepted. Recursive graphs, explicit `!!timestamp`
  and `!!binary` tags, invalid Unicode escapes, duplicate mapping keys, and
  mapping keys that do not resolve to strings are rejected. These decisions do
  not change the JavaScript parser.
- YAML frontmatter is limited to **1 MiB UTF-8 input**, **64 value levels**
  (root/scalars count; alias-expanded depth counts), **100,000 loaded nodes**,
  and **8 MiB loaded scalar/tag text**. Limits are inclusive. Node/text costs
  include anchor storage copies and alias expansion, not only the final tree.
  Markdown body bytes are not part of these YAML budgets.
- A bounded pass over Saphyr parser events checks these costs before either
  Saphyr loader runs or recursive domain conversion starts. It stores only
  collection/anchor costs, never expanded values; rejection stops event parsing.
  The input cap applies before event parsing. Saphyr still owns YAML syntax,
  scalar interpretation, tags, and loading; it exposes no loader budget hook.
  Limit violations retain `ERR_OKF_PARSE` in preparation and validation.

These deliberately generous frontmatter bounds allow ordinary metadata while
bounding loader copies and recursion. The comparison corpus has 13,692 documents;
its observed frontmatter maximum is about 2 KiB. The 1 MiB cap leaves substantial
headroom without limiting large Markdown bodies. The extra parser pass costs
linear work on accepted input; budgets are not a claim of an exact process-memory
ceiling, and large or heavily aliased metadata can now be rejected intentionally.

## Local checks

Rust 1.88.0 (with rustfmt/clippy), Node, and workspace pnpm dependencies are
required. Ensure the existing Cargo installation is on PATH. Run from the repo:

```sh
pnpm --filter okf-prepare-native build
pnpm --filter okf-prepare-native typecheck
pnpm --filter okf-prepare-native check:rust
pnpm --filter okf-prepare-native test
```

The build creates an ignored debug host `.node` and ESM entry. `test` rebuilds
before loading that binary through the actual package entry and host loader.
No search addon, prebuilt substitute, or platform publication is involved.

## Limits

This is the core's projection, **not** the full `PreparedOkfDocument` contract.
Unknown extensions are not returned. JavaScript parser parity is unproven;
UTF-16/lone-surrogate preservation and YAML graph compatibility are unsupported
by this boundary contract. Differential corpus evidence is not universal parser
parity. No batch/filesystem API,
CJS entry matrix, WASM support, or release/platform matrix is provided here.
Resolve these limits before public migration; these tests prove only the
explicit native-boundary fixtures.
