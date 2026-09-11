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
by this boundary contract. No differential/corpus proof, batch/filesystem API,
CJS entry matrix, WASM support, or release/platform matrix is provided here.
Resolve these limits before public migration; these tests prove only the
explicit native-boundary fixtures.
