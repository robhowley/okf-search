# Development

Development requires Rust `1.88.0`:

```sh
pnpm install
pnpm --filter okf-search-native run build
pnpm --filter okf-search-native run check:rust
pnpm --filter okf-search-native run typecheck
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

## Native lifecycle and mapped workspaces

`openOkf` defaults to the in-memory backend. Root opens may opt into
`{ cachePath, storage: "mmap" }`; `cachePath` is required, and invalid options
or mmap initialization failures reject without a memory fallback. The portable
`.okf` archive remains an ordinary file. Each mapped handle extracts a private
Tantivy workspace under the operating system's temporary directory, so mapped
indexes can use extra disk space and can contain plaintext index data. Existing
handles keep their private views when another handle replaces the archive.

All handles expose non-saving `close()`. It stops admission immediately and
drains an accepted save before teardown. Save publication and close cleanup
have independent outcomes. Successful mapped close removes its workspace; an
uncertain shutdown or failed removal retains the path and reports
`ERR_OKF_CLOSE`. Manual cleanup is safe only after verifying that no process
still uses the retained workspace. Prepared constructors remain memory-only and
have no mmap storage option.

Mmap `save()` captures committed files synchronously before returning its
promise, so a large index can block the calling thread. A save captures the
handle's complete view at invocation and replaces the destination; it does not
merge or refresh the handle. A stale handle can therefore replace newer work.

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

The native-artifact CI matrix runs native typecheck and the full
`pnpm run test` suite on every supported OS artifact with `CARGO_BUILD_TARGET`
set to that row's target. Rust
test helpers and the loaded addon therefore use the same architecture.

Persistence writes one opaque cache payload plus a retained sibling lock file
(`.<basename>.okf-lock`) and temporary siblings during publication. The lock
file is coordination metadata, not a second cache payload. A killed process can
leave an owned temporary file; v1 cleanup of such orphans is intentionally
manual. Atomic replacement protects cooperating local-filesystem readers, not
power-loss durability or arbitrary network-filesystem behavior.

Cache format 3 stores `OKFCACHE`, a little-endian u32 version, u64 compressed
manifest length, u64 JSON length, one zstd level-3 JSON frame, unchanged Tantivy
files in manifest order, then SHA-256 of the compressed manifest and file bytes.
The header is 28 bytes; the digest is 32 bytes. Metadata limits are 65 MiB encoded,
64 MiB decoded, and a 64 MiB decoder window. Loading verifies the digest before
decoding and rejects extra frames, trailing bytes, truncation, and length mismatches.
The document map retains membership, paths, classifications, section counts, and
ordered nonempty diagnostics (code, message, optional field). It omits nested
IDs, section-ID lists, diagnostic paths, empty diagnostics, and conformance.
Loading reconstructs exact section IDs during the live Tantivy scan, restores
diagnostic paths from their document, and derives conformance from diagnostics.
Zero-section documents remain in the inventory; source files are never read.

Save validates the original detached runtime inventory before reducing metadata.
Load checks known owners, globally unique section IDs, counts, paths,
classifications, and indexed/stored agreement. No independent ownership digest is
stored: coordinated checksum-resigned ID rewrites that remain internally
consistent are not promised detection. The checksum is not authentication.
Formats 1 and 2 are incompatible; there is no migration or automatic rebuild.

`indexStats().storage.sizeInBytes` is sampled backing size, not RSS. Memory mode
samples the `RamDirectory`; mmap sums regular files in one scan of the private
workspace, including management, lock, temporary, and obsolete files present at
that moment. It is not an exact committed-generation size or mapped-page count.

## Package and release validation

From the repository root, run `pnpm package:check` for the full build,
Rust checks, declarations, tests, packing, and consumer validation. Run
`pnpm test:release-workflow` for the release workflow tests. The native release
consumer includes one packed-package smoke that opens mmap storage, searches,
saves, and closes it. Keep the four checked-in targets and the Linux
`GLIBC_2.17` floor unchanged.


