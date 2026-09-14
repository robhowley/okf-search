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

`tests/persistence.test.ts` exercises the package facade's cache lifecycle,
round trips, mutation capture, corrupt-cache rejection, atomic readers, and
writer exclusion. `tests/package-api.test.mjs` repeats the essential cache hit,
miss, fresh-process, replacement, and corruption cases through the built CJS
package. The native-artifact CI matrix runs the full `pnpm run test` suite on
every supported OS artifact with `CARGO_BUILD_TARGET` set to that row's target,
so Rust test helpers and the loaded addon use the same architecture.

Persistence writes one opaque cache payload plus a retained sibling lock file
(`.<basename>.okf-lock`) and temporary siblings during publication. The lock
file is coordination metadata, not a second cache payload. A killed process can
leave an owned temporary file; cleanup of such orphans is intentionally manual
in v1. Atomic replacement protects cooperating local-filesystem readers, not
power-loss durability or arbitrary network-filesystem behavior.


