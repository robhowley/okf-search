import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { builtinModules, createRequire } from "node:module";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

import { build } from "esbuild";
import { rollup } from "rollup";
import { dts } from "rollup-plugin-dts";

import {
  buildNativeFacade,
} from "../packages/okf-search-native/scripts/build-facade.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const privateEntries = new Map([
  [
    "@okf-internal/prepare",
    join(repoRoot, "packages", "okf-prepare", "src", "index.ts"),
  ],
  [
    "@okf-internal/prepare/node",
    join(repoRoot, "packages", "okf-prepare", "src", "node.ts"),
  ],
]);

export function privateSourcePlugin() {
  return {
    name: "resolve-private-prepare-source",
    setup(build) {
      build.onResolve({ filter: /^@okf-internal\/prepare(?:\/node)?$/ }, (args) => {
        const path = privateEntries.get(args.path);
        return path ? { path } : undefined;
      });
    },
  };
}

export function privateDeclarationSourcePlugin() {
  return {
    name: "resolve-private-prepare-declarations",
    resolveId(id) {
      return privateEntries.get(id) ?? null;
    },
  };
}

const privateSpecifier = "@okf-internal/prepare";
const privateSource = join(repoRoot, "packages", "okf-prepare", "src", "index.ts");
const expectedExports = ["createPrepareBundleSentinel"];
const nativeFacadeExports = [
  "OkfError",
  "createOkfSearch",
  "openOkf",
  "validateOkfDocument",
];
const nativeSpecifier = "../native.cjs";
const targets = {
  minisearch: {
    entrypoint: join(
      repoRoot,
      "packages",
      "okf-minisearch",
      "test",
      "support",
      "prepare-bundle-entry.ts",
    ),
    privateSources: [{ label: privateSpecifier, paths: [privateSource] }],
    artifacts: [
      { name: "node", platform: "node", format: "esm", target: "node20", extension: "mjs" },
      { name: "browser", platform: "browser", format: "esm", target: "es2022", extension: "mjs" },
      { name: "browser-global", platform: "browser", format: "iife", target: "es2022", extension: "js", globalName: "OkfPrepareBundleProof", minify: true },
    ],
  },
  native: {
    external: [nativeSpecifier],
  },
};

const targetName = process.argv[2];
const selected = targets[targetName];
assert.ok(selected, "usage: node scripts/check-private-bundling.mjs <minisearch|native>");
assert.equal(process.argv.length, 3, "the bundling proof accepts exactly one target");

function assertSentinel(api, label) {
  assert.deepEqual(Object.keys(api).sort(), expectedExports, `${label}: unexpected exports`);
  const sentinel = api.createPrepareBundleSentinel();
  assert.equal(sentinel.marker, "okf-prepare-bundled", `${label}: wrong marker`);
  assert.equal(sentinel.value, 73, `${label}: wrong value`);
}

function assertNoPrivateReference(contents, label) {
  assert.equal(contents.includes(privateSpecifier), false, `${label}: private package specifier leaked`);
  assert.equal(contents.includes("workspace:"), false, `${label}: workspace protocol leaked`);
}

const builtinModuleNames = new Set(builtinModules);

function assertExternalRuntimeModules(metafile, expected, label) {
  const external = new Set();
  for (const input of Object.values(metafile.inputs)) {
    for (const item of input.imports ?? []) {
      if (item.external) external.add(item.path);
    }
  }

  const runtime = [...external]
    .filter((specifier) => !isBuiltinModule(specifier))
    .sort();
  assert.deepEqual(
    runtime,
    [...new Set(expected)].sort(),
    `${label}: unexpected external runtime modules`,
  );
}

function isBuiltinModule(specifier) {
  const name = specifier.startsWith("node:")
    ? specifier.slice("node:".length)
    : specifier;
  return builtinModuleNames.has(name);
}

async function assertPrivateBytes(metafile, sources, label) {
  for (const source of sources) {
    const privateInputs = [];
    for (const sourcePath of source.paths) {
      const expectedPath = await realpath(sourcePath);
      let privateInput;

      for (const input of Object.keys(metafile.inputs)) {
        const inputPath = resolve(repoRoot, input);
        try {
          if (await realpath(inputPath) === expectedPath) {
            privateInput = input;
            break;
          }
        } catch {
          // Ignore virtual inputs.
        }
      }

      assert.ok(
        privateInput,
        `${label}: ${source.label} source is absent from the esbuild metafile`,
      );
      privateInputs.push(privateInput);
    }

    const bytes = Object.values(metafile.outputs).reduce(
      (total, output) => total + privateInputs.reduce(
        (sourceBytes, input) =>
          sourceBytes + (output.inputs[input]?.bytesInOutput ?? 0),
        0,
      ),
      0,
    );
    assert.ok(
      bytes > 0,
      `${label}: ${source.label} source contributed no emitted bytes`,
    );
  }
}

async function buildMinisearchJavaScript(temporaryRoot, artifact) {
  const output = join(
    temporaryRoot,
    `${artifact.name}-${artifact.format}.${artifact.extension}`,
  );
  const result = await build({
    absWorkingDir: repoRoot,
    entryPoints: [selected.entrypoint],
    outfile: output,
    bundle: true,
    packages: "bundle",
    metafile: true,
    sourcemap: false,
    legalComments: "none",
    logLevel: "silent",
    platform: artifact.platform,
    format: artifact.format,
    target: artifact.target,
    globalName: artifact.globalName,
    plugins: [privateSourcePlugin()],
    banner: artifact.platform === "node" && artifact.format === "esm"
      ? {
          js: 'import { createRequire as __okfCreateRequire } from "node:module";\nconst require = __okfCreateRequire(import.meta.url);',
        }
      : undefined,
    minify: artifact.minify ?? false,
  });

  const label = `${targetName} ${artifact.name} ${artifact.format}`;
  await assertPrivateBytes(result.metafile, selected.privateSources, label);

  const code = await readFile(output, "utf8");
  assertNoPrivateReference(code, label);

  if (artifact.format === "iife") {
    const context = {};
    runInNewContext(code, context);
    assertSentinel(context.OkfPrepareBundleProof, label);
  } else if (artifact.format === "cjs") {
    assertSentinel(createRequire(import.meta.url)(output), label);
  } else {
    assertSentinel(await import(pathToFileURL(output).href), label);
  }
}

async function buildDeclarations(temporaryRoot) {
  const outputDirectory = targetName === "native"
    ? join(temporaryRoot, "native-facade", "dist")
    : temporaryRoot;
  await mkdir(outputDirectory, { recursive: true });
  const output = join(
    outputDirectory,
    targetName === "native" ? "index.d.ts" : `${targetName}.d.ts`,
  );
  const filenames = targetName === "native"
    ? ["index.d.mts", "index.d.cts", "index.d.ts"]
    : [basename(output)];

  if (targetName !== "native") {
    const bundle = await rollup({
      input: selected.entrypoint,
      plugins: [privateDeclarationSourcePlugin(), dts({ respectExternal: false })],
      onwarn(warning) {
        throw new Error(`Rollup warning: ${warning.message}`);
      },
    });

    let declaration;
    try {
      const generated = await bundle.generate({ format: "es" });
      const chunk = generated.output.find((item) => item.type === "chunk");
      if (!chunk) {
        throw new Error("Declaration bundling produced no output");
      }
      declaration = chunk.code;
    } finally {
      await bundle.close();
    }
    await writeFile(output, declaration);
  }

  for (const filename of filenames) {
    const contents = await readFile(join(outputDirectory, filename), "utf8");
    assertNoPrivateReference(contents, `${targetName} ${filename}`);
    if (targetName === "native") {
      assertNativeDeclaration(contents, `${targetName} ${filename}`);
    } else {
      assert.match(contents, /createPrepareBundleSentinel/);
      assert.match(contents, /readonly marker: ["']okf-prepare-bundled["']/);
      assert.match(contents, /readonly value: 73/);
    }
  }

  const consumerRoot = await mkdtemp(join(tmpdir(), "okf-prepare-declaration-consumer-"));
  try {
    const packageName = targetName === "native"
      ? "okf-search-native"
      : "prepare-bundle-proof";
    const packageRoot = join(consumerRoot, "node_modules", packageName);
    await mkdir(packageRoot, { recursive: true });
    await copyFile(output, join(packageRoot, "index.d.ts"));
    await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({
      name: packageName,
      private: true,
      type: "module",
      types: "./index.d.ts",
    }, null, 2)}\n`);
    const consumer = targetName === "native"
      ? `import { OkfError, createOkfSearch, openOkf, validateOkfDocument } from "okf-search-native";\nimport type { OkfDocumentInput, OkfSearch, OkfValidationResult } from "okf-search-native";\n\nconst input: OkfDocumentInput = { path: "types.md", markdown: "" };\nconst index: OkfSearch = createOkfSearch([input]);\nconst validation: OkfValidationResult = validateOkfDocument(input);\nconst opened: Promise<OkfSearch> = openOkf("knowledge");\nconst error = new OkfError("ERR_OKF_UNSUPPORTED", "autoSuggest");\nvoid [index, validation, opened, error];\n`
      : `import { createPrepareBundleSentinel } from "prepare-bundle-proof";\nconst sentinel = createPrepareBundleSentinel();\nconst marker: "okf-prepare-bundled" = sentinel.marker;\nconst value: 73 = sentinel.value;\nvoid [marker, value];\n`;
    await writeFile(join(consumerRoot, "consumer.ts"), consumer);
    await writeFile(join(consumerRoot, "tsconfig.json"), `${JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: [],
      },
      include: ["consumer.ts"],
    }, null, 2)}\n`);

    assert.throws(
      () => createRequire(join(consumerRoot, "probe.cjs")).resolve(privateSpecifier),
      (error) => error?.code === "MODULE_NOT_FOUND",
      "the declaration consumer unexpectedly resolves the private package",
    );
    const tsc = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
    const result = spawnSync(
      process.execPath,
      [tsc, "--project", "tsconfig.json", "--pretty", "false"],
      { cwd: consumerRoot, encoding: "utf8" },
    );
    assert.equal(
      result.status,
      0,
      `declaration consumer failed to compile:\n${result.stdout}${result.stderr}`,
    );
  } finally {
    await rm(consumerRoot, { recursive: true, force: true });
  }
}

function assertNativeDeclaration(declaration, label) {
  for (const exportName of nativeFacadeExports) {
    assert.ok(
      declaration.includes(exportName),
      `${label}: missing ${exportName} declaration`,
    );
  }
  assert.doesNotMatch(
    declaration,
    /NativeOkfSearch|PreparedDocument|createPrepareBundleSentinel/,
    `${label}: prepared implementation declaration leaked`,
  );
}

async function assertNativePackageManifest() {
  const manifest = JSON.parse(await readFile(
    join(repoRoot, "packages", "okf-search-native", "package.json"),
    "utf8",
  ));
  // The private workspace link is build metadata; scan the production-facing manifest.
  const emittedManifest = Object.fromEntries(
    Object.entries(manifest).filter(([key]) =>
      key !== "devDependencies" && key !== "scripts"),
  );
  assertNoPrivateReference(JSON.stringify(emittedManifest), "native package manifest");
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "okf-prepare-bundle-"));
try {
  if (targetName === "native") {
    await assertNativePackageManifest();
    const outputDirectory = join(temporaryRoot, "native-facade", "dist");
    const { javascriptBuilds } = await buildNativeFacade({
      outputDirectory,
      metafile: true,
    });
    for (const artifact of javascriptBuilds) {
      const label = `native index ${artifact.format}`;
      assert.ok(artifact.metafile, `${label}: facade builder returned no metafile`);
      for (const input of Object.keys(artifact.metafile.inputs)) {
        assert.doesNotMatch(input, /okf-prepare|prepared-to-native|yaml|mdast|micromark/, `${label}: JS preparation input shipped`);
      }
      assertExternalRuntimeModules(artifact.metafile, selected.external, label);
      assertNoPrivateReference(
        await readFile(join(outputDirectory, artifact.filename), "utf8"),
        label,
      );
    }
  } else {
    for (const artifact of selected.artifacts) {
      await buildMinisearchJavaScript(temporaryRoot, artifact);
    }
  }
  await buildDeclarations(temporaryRoot);
  console.log(targetName === "native"
    ? "native: JS preparation absent; facade and declarations passed"
    : "minisearch: private JS and declaration bundling proof passed");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
