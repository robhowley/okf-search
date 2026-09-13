import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function markdown(type, marker) {
  return `---\ntype: ${type}\n---\n${marker}\n`;
}

function preparedDocument(documentId, marker) {
  return {
    documentId,
    path: `${documentId}.md`,
    type: "note",
    conformance: "strict",
    diagnostics: [],
    title: `Prepared ${marker}`,
    tags: ["native"],
    status: "stable",
    staleAfterEpoch: undefined,
    stalenessClassified: true,
    trustTier: "human-reviewed",
    resource: documentId,
    description: "Prepared native package API fixture",
    sourceText: marker,
    sections: [{
      sectionId: `${documentId}#root`,
      headingPath: "Overview",
      text: marker,
      startLine: 1,
      endLine: 3,
    }],
  };
}

function isInvalidPreparedDocument(error) {
  return error instanceof Error &&
    error.message.startsWith("[ERR_OKF_INVALID_PREPARED_DOCUMENT]");
}

function isInvalidSearchOptions(error) {
  return error instanceof Error &&
    error.message.startsWith("[ERR_OKF_INVALID_SEARCH_OPTIONS]");
}

test("manifest exposes only the friendly root and prepared binding", async () => {
  const manifest = await readJson(join(packageRoot, "package.json"));

  assert.equal(manifest.type, undefined);
  assert.equal(manifest.main, "./dist/index.cjs");
  assert.equal(manifest.module, "./dist/index.mjs");
  assert.equal(manifest.types, "./dist/index.d.ts");
  assert.deepEqual(manifest.exports, {
    ".": {
      import: {
        types: "./dist/index.d.mts",
        default: "./dist/index.mjs",
      },
      require: {
        types: "./dist/index.d.cts",
        default: "./dist/index.cjs",
      },
      default: "./dist/index.mjs",
    },
    "./prepared": {
      types: "./native.d.cts",
      import: "./native.cjs",
      require: "./native.cjs",
      default: "./native.cjs",
    },
  });
  assert.deepEqual(manifest.files, [
    "dist",
    "native.cjs",
    "native.d.cts",
    "okf-search-native.*.node",
  ]);
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.optionalDependencies, undefined);
  assert.equal(manifest.browser, undefined);
  assert.equal(manifest.scripts.install, undefined);
  assert.equal(manifest.exports["./native.cjs"], undefined);
});

test("root declarations are identical and contain no private package reference", async () => {
  const declarations = await Promise.all([
    "index.d.mts",
    "index.d.cts",
    "index.d.ts",
  ].map((filename) => readFile(join(packageRoot, "dist", filename), "utf8")));

  assert.equal(declarations[0], declarations[1]);
  assert.equal(declarations[1], declarations[2]);
  assert.doesNotMatch(declarations[0], /@okf-internal\/|workspace:/);
});

test("ESM and CommonJS resolve the root and prepared subpath", async () => {
  const esmRoot = await import("okf-search-native");
  const cjsRoot = require("okf-search-native");
  const esmPrepared = await import("okf-search-native/prepared");
  const cjsPrepared = require("okf-search-native/prepared");

  for (const root of [esmRoot, cjsRoot]) {
    assert.deepEqual(Object.keys(root).sort(), [
      "OkfError",
      "createOkfSearch",
      "openOkf",
      "validateOkfDocument",
    ]);
    assert.equal("default" in root, false);
    assert.equal("NativeOkfSearch" in root, false);

    const error = new root.OkfError("ERR_OKF_UNSUPPORTED", "autoSuggest");
    assert.equal(error.name, "OkfError");
    assert.equal(error.code, "ERR_OKF_UNSUPPORTED");
    assert.equal(error.path, "autoSuggest");
    assert.equal(error.message, "Unsupported OKF operation: autoSuggest");
    assert.equal(Object.hasOwn(error, "field"), false);
    assert.equal(Object.hasOwn(error, "cause"), false);

    const index = root.createOkfSearch([{
      path: "package-api.md",
      markdown: "---\ntype: note\n---\npackage-api-marker\n",
    }]);
    assert.equal(index.search("package-api-marker")[0]?.documentId, "package-api");
    assert.equal(root.validateOkfDocument({
      path: "valid.md",
      markdown: "---\ntype: note\n---\nvalid\n",
    }).isValid, true);
  }

  for (const prepared of [esmPrepared, cjsPrepared]) {
    assert.equal(typeof prepared.NativeOkfSearch.fromPrepared, "function");
    const index = prepared.NativeOkfSearch.fromPrepared([]);
    assert.deepEqual(index.listTypes(), []);
  }
  assert.deepEqual(Object.keys(cjsPrepared), ["NativeOkfSearch"]);

  const index = cjsRoot.createOkfSearch([
    { path: "smoke.md", markdown: markdown("note", "friendly-runtime-marker") },
  ]);
  assert.equal(index.ingest({
    path: "nested/added.md",
    markdown: markdown("guide", "friendly-ingest-marker"),
  }).conformance, "strict");
  assert.deepEqual(index.listTypes(), ["guide", "note"]);
  assert.equal(index.remove("./nested//added.md"), true);
  assert.deepEqual(index.search("friendly-ingest-marker", { match: "all" }), []);
  assert.throws(
    () => index.autoSuggest("friendly"),
    (error) => error instanceof cjsRoot.OkfError &&
      error.code === "ERR_OKF_UNSUPPORTED" &&
      error.path === "autoSuggest",
  );

  const prepared = cjsPrepared.NativeOkfSearch.fromPrepared([
    preparedDocument("prepared", "prepared-runtime-marker"),
  ]);
  assert.equal(prepared.search("prepared-runtime-marker")[0]?.documentId, "prepared");
  const preparedStats = prepared.indexStats();
  assert.deepEqual(preparedStats.logical.documents, {
    total: 1,
    strict: 1,
    degraded: 0,
  });
  assert.equal(preparedStats.storage.kind, "in-memory-index-files");
  assert.ok(preparedStats.storage.sizeInBytes > 0);
  prepared.ingestPrepared(preparedDocument("prepared-added", "prepared-ingest-marker"));
  assert.equal(prepared.search("prepared-ingest-marker", { match: "all" }).length, 1);
  assert.equal(prepared.removeDocument("prepared-added"), true);
  assert.deepEqual(prepared.search("prepared-ingest-marker", { match: "all" }), []);
  assert.equal(prepared.removeDocument("prepared-added"), false);
  assert.equal(prepared.removeDocument("missing"), false);

  const directoryRoot = await mkdtemp(join(tmpdir(), "okf-search-native-package-api-"));
  try {
    const nestedRoot = join(directoryRoot, "nested");
    await mkdir(nestedRoot, { recursive: true });
    await writeFile(
      join(nestedRoot, "directory.md"),
      markdown("guide", "friendly-directory-marker"),
    );

    const directoryIndex = await cjsRoot.openOkf(directoryRoot);
    assert.equal(
      directoryIndex.search("friendly-directory-marker")[0]?.documentId,
      "nested/directory",
    );
    assert.deepEqual(directoryIndex.listTypes(), ["guide"]);
    assert.equal(directoryIndex.ingest({
      path: "added.md",
      markdown: markdown("note", "friendly-directory-ingest-marker"),
    }).conformance, "strict");
    assert.deepEqual(directoryIndex.listTypes(), ["guide", "note"]);
    assert.equal(directoryIndex.remove("./added.md"), true);
    assert.equal(directoryIndex.remove("nested/directory.md"), true);
    assert.deepEqual(directoryIndex.listTypes(), []);
    assert.deepEqual(
      directoryIndex.search("friendly-directory-marker", { match: "all" }),
      [],
    );
  } finally {
    await rm(directoryRoot, { recursive: true, force: true });
  }
});

test("prepared native construction rejects invalid line numbers", () => {
  const { NativeOkfSearch } = require("okf-search-native/prepared");
  const cases = [
    ["fractional startLine", { startLine: 1.5 }],
    ["fractional endLine", { endLine: 3.5 }],
    ["negative startLine", { startLine: -1 }],
    ["negative endLine", { endLine: -1 }],
    ["zero startLine", { startLine: 0 }],
    ["zero endLine", { endLine: 0 }],
    ["oversized startLine", { startLine: 2 ** 32 }],
    ["oversized endLine", { endLine: 2 ** 32 }],
    ["non-finite startLine", { startLine: Number.NaN }],
    ["non-finite endLine", { endLine: Number.POSITIVE_INFINITY }],
    ["reversed line bounds", { startLine: 3, endLine: 2 }],
  ];

  for (const [name, bounds] of cases) {
    const document = preparedDocument(`invalid-${name}`, name);
    Object.assign(document.sections[0], bounds);
    assert.throws(
      () => NativeOkfSearch.fromPrepared([document]),
      isInvalidPreparedDocument,
      name,
    );
  }

  const maximum = preparedDocument("maximum-line", "maximum-line");
  Object.assign(maximum.sections[0], {
    startLine: 2 ** 32 - 1,
    endLine: 2 ** 32 - 1,
  });
  const index = NativeOkfSearch.fromPrepared([maximum]);
  assert.equal(index.search("maximum-line")[0]?.startLine, 2 ** 32 - 1);
  assert.equal(index.search("maximum-line")[0]?.endLine, 2 ** 32 - 1);
});

test("rejected prepared ingest preserves a usable native index", () => {
  const { NativeOkfSearch } = require("okf-search-native/prepared");
  const index = NativeOkfSearch.fromPrepared([
    preparedDocument("prepared-seed", "prepared-seed-marker"),
  ]);
  const invalid = preparedDocument("prepared-invalid", "prepared-invalid-marker");
  invalid.sections[0].startLine = -1;

  assert.throws(
    () => index.ingestPrepared(invalid),
    isInvalidPreparedDocument,
  );
  assert.equal(index.search("prepared-seed-marker")[0]?.documentId, "prepared-seed");
  assert.deepEqual(index.search("prepared-invalid-marker", { match: "all" }), []);
  assert.deepEqual(index.listTypes(), ["note"]);
});

test("prepared search rejects malformed where and boost containers", () => {
  const { NativeOkfSearch } = require("okf-search-native/prepared");
  const marker = "prepared-search-options-marker";
  const index = NativeOkfSearch.fromPrepared([
    preparedDocument("prepared-options", marker),
  ]);

  for (const [property, values] of [
    ["where", [null, false, 1, "primitive", []]],
    ["boost", [null, false, 1, "primitive", []]],
  ]) {
    for (const value of values) {
      assert.throws(
        () => index.search(marker, { [property]: value }),
        isInvalidSearchOptions,
        `${property}=${String(value)}`,
      );
    }
  }

  assert.equal(index.search(marker).length, 1);
  assert.equal(index.search(marker, undefined).length, 1);
  assert.equal(index.search(marker, {}).length, 1);
  assert.equal(index.search(marker, { where: {} }).length, 1);
  assert.equal(index.search(marker, { boost: {} }).length, 1);
});

test("prepared search option getters can reenter read-only native inventory", async () => {
  const document = preparedDocument("prepared-reentry", "prepared-reentry-marker");
  const script = `
    const { NativeOkfSearch } = require(${JSON.stringify(join(packageRoot, "native.cjs"))});
    const index = NativeOkfSearch.fromPrepared([${JSON.stringify(document)}]);
    let reentered = false;
    const options = {};
    Object.defineProperty(options, "where", {
      enumerable: true,
      get() {
        reentered = true;
        if (index.listTypes().join(",") !== "note") {
          throw new Error("unexpected native inventory");
        }
        return {};
      },
    });
    const hits = index.search("prepared-reentry-marker", options);
    if (!reentered || hits.length !== 1) {
      throw new Error("search option getter did not reenter successfully");
    }
  `;

  await execFileAsync(process.execPath, ["-e", script], {
    cwd: packageRoot,
    timeout: 2_000,
  });
});

test("the physical generated loader is blocked by the export map", async () => {
  await assert.rejects(
    import("okf-search-native/native.cjs"),
    (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
  );
  assert.throws(
    () => require("okf-search-native/native.cjs"),
    (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
  );
});
