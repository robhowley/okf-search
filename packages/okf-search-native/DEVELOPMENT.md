# Development

Development requires Rust `1.88.0`:

```sh
pnpm install
pnpm --filter okf-search-native run build
pnpm --filter okf-search-native run check:rust
pnpm --filter okf-search-native run test
```

## Build output and release artifacts

`napi build` generates `native.cjs`, `native.d.cts`, and the host `.node`
artifact. The package facade build writes `dist/index.cjs`, `dist/index.mjs`,
`dist/index.d.cts`, `dist/index.d.mts`, and `dist/index.d.ts`. Generated native
loader names are internal and are not package-root exports.

For multi-target candidate assembly, copy the four tested `.node` files into the
package root, then run `pnpm run verify:release-artifacts`. The verifier derives
the required artifact names from the checked-in target list and rejects missing
or extra native files. CI also uses its `glibc <artifact>` mode to reject Linux
addons that import symbols newer than `GLIBC_2.17`.

## Persistence checks

The package `test` command above covers persistence at three boundaries:

- `tests/persistence.test.ts` checks the package facade's cache lifecycle,
  round trips, mutation capture, corrupt-cache rejection, atomic readers, and
  same-destination writer exclusion.
- `tests/package-api.test.mjs` repeats cache hit, miss, fresh-process reuse,
  replacement, corruption, and child/worker writer cases through the built CJS
  package.
- Rust tests in `src/persistence.rs` check payload validation, failed
  publication, process death, filesystem aliases, and platform-specific
  replacement behavior.

The native-artifact CI matrix runs the full `pnpm run test` suite on every
supported OS artifact with `CARGO_BUILD_TARGET` set to that row's target. Rust
test helpers and the loaded addon therefore use the same architecture.

Persistence writes one opaque cache payload plus a retained sibling lock file
(`.<basename>.okf-lock`) and temporary siblings during publication. The lock
file is coordination metadata, not a second cache payload. A killed process can
leave an owned temporary file; v1 cleanup of such orphans is intentionally
manual. Atomic replacement protects cooperating local-filesystem readers, not
power-loss durability or arbitrary network-filesystem behavior.

Cache format 2 stores `OKFCACHE`, a little-endian u32 version, u64 compressed
manifest length, u64 JSON length, one zstd level-3 JSON frame, unchanged Tantivy
files in manifest order, then SHA-256 of the compressed manifest and file bytes.
The header is 28 bytes; the digest is 32 bytes. Metadata limits are 65 MiB encoded,
64 MiB decoded, and a 64 MiB decoder window. Loading verifies the digest before
decoding and rejects extra frames, trailing bytes, truncation, and length mismatches.
Inventory and index validation are unchanged. Older formats are incompatible;
there is no migration or automatic rebuild.


