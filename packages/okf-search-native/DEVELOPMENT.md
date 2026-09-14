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


