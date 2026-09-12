import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildNativeFacade } from "../packages/okf-search-native/scripts/build-facade.mjs";

assert.deepEqual(process.argv.slice(2), ["native"], "usage: node scripts/check-private-bundling.mjs native");
const temporaryRoot = await mkdtemp(join(tmpdir(), "okf-native-bundle-"));
try {
  const { javascriptBuilds } = await buildNativeFacade({
    outputDirectory: temporaryRoot,
    metafile: true,
  });
  for (const artifact of javascriptBuilds) {
    const label = `native index ${artifact.format}`;
    assert.ok(artifact.metafile, `${label}: facade builder returned no metafile`);
    const external = new Set();
    for (const [path, input] of Object.entries(artifact.metafile.inputs)) {
      assert.doesNotMatch(path, /okf-prepare|prepared-to-native|yaml|mdast|micromark/, `${label}: JS preparation input shipped`);
      for (const item of input.imports ?? []) {
        if (item.external && !builtinModules.includes(item.path.replace(/^node:/, ""))) {
          external.add(item.path);
        }
      }
    }
    assert.deepEqual([...external].sort(), ["../native.cjs"], `${label}: unexpected external runtime modules`);
    assert.doesNotMatch(
      await readFile(join(temporaryRoot, artifact.filename), "utf8"),
      /@okf-internal\/|workspace:/,
      `${label}: private runtime reference leaked`,
    );
  }
  for (const filename of ["index.d.mts", "index.d.cts", "index.d.ts"]) {
    const declaration = await readFile(join(temporaryRoot, filename), "utf8");
    for (const name of ["OkfError", "createOkfSearch", "openOkf", "validateOkfDocument"]) {
      assert.ok(declaration.includes(name), `${filename}: missing ${name} declaration`);
    }
    assert.doesNotMatch(declaration, /NativeOkfSearch|PreparedDocument|@okf-internal\/|workspace:/, `${filename}: private declaration leaked`);
  }
  console.log("native: JS preparation absent; facade and declarations passed");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
