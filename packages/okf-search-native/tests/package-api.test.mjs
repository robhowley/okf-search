import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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

test("prepared search validates snippetLength without truncation", () => {
  const { NativeOkfSearch } = require("okf-search-native/prepared");
  const marker = "prepared-snippet-length-marker";
  const index = NativeOkfSearch.fromPrepared([
    preparedDocument("prepared-snippet-length", marker),
  ]);

  assert.equal(index.search(marker, { snippetLength: 1 }).length, 1);
  assert.equal(
    index.search(marker, { snippetLength: Number.MAX_SAFE_INTEGER }).length,
    1,
  );
  for (const snippetLength of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () => index.search(marker, { snippetLength }),
      isInvalidSearchOptions,
      `snippetLength=${String(snippetLength)}`,
    );
  }

  for (const snippetLength of [null, "1", true, 1n, {}, []]) {
    assert.throws(
      () => index.search(marker, { snippetLength }),
      `snippetLength=${String(snippetLength)}`,
    );
  }
});

test("prepared snippets use fuzzy, prefix, Unicode, and body-field anchors", () => {
  const { NativeOkfSearch } = require("okf-search-native/prepared");
  const fuzzyBody = `${"introduction ".repeat(20)} retrievel ${"filler ".repeat(60)} retrieval`;
  const prefixBody = `${"introduction ".repeat(20)} apropos ${"filler ".repeat(50)} profile`;
  const unicodeBody = `${"中".repeat(100)} İstanbul 😀 retrieval ${"z".repeat(250)}`;
  const excludedBody = `${"leading ".repeat(80)} excludedneedle`;
  const excluded = preparedDocument("prepared-body-excluded", excludedBody);
  excluded.title = "excludedneedle";

  const index = NativeOkfSearch.fromPrepared([
    preparedDocument("prepared-fuzzy-anchor", fuzzyBody),
    preparedDocument("prepared-prefix-anchor", prefixBody),
    preparedDocument("prepared-unicode-anchor", unicodeBody),
    excluded,
  ]);

  const fuzzy = index.search("rexrieval", {
    fields: ["body"],
    fuzzy: 0.2,
    snippetLength: 240,
  }).find((hit) => hit.documentId === "prepared-fuzzy-anchor");
  assert.ok(fuzzy);
  assert.match(fuzzy.snippet, /retrievel/);
  assert.doesNotMatch(fuzzy.snippet, /retrieval/);
  assert.deepEqual(index.search("rexrieval", {
    fields: ["body"],
    fuzzy: false,
  }), []);
  assert.deepEqual(index.search("rexrieval", {
    fields: ["body"],
    fuzzy: 0,
  }), []);

  const prefix = index.search("pro", {
    fields: ["body"],
    fuzzy: false,
    snippetLength: 240,
  }).find((hit) => hit.documentId === "prepared-prefix-anchor");
  assert.ok(prefix);
  assert.match(prefix.snippet, /profile/);
  assert.doesNotMatch(prefix.snippet, /apropos/);
  assert.deepEqual(index.search("pr", {
    fields: ["body"],
    fuzzy: false,
  }), []);

  const unicode = index.search("rexrieval", {
    fields: ["body"],
    fuzzy: 0.2,
    snippetLength: 240,
  }).find((hit) => hit.documentId === "prepared-unicode-anchor");
  assert.equal(
    unicode?.snippet,
    `…${"中".repeat(67)} İstanbul 😀 retrieval ${"z".repeat(150)}…`,
  );

  const bodyExcluded = index.search("excludedneedle", {
    fields: ["title"],
    snippetLength: 32,
  }).find((hit) => hit.documentId === "prepared-body-excluded");
  assert.ok(bodyExcluded);
  assert.match(bodyExcluded.snippet, /^leading/);
  assert.doesNotMatch(bodyExcluded.snippet, /excludedneedle/);

  const tiny = index.search("rexrieval", {
    fields: ["body"],
    fuzzy: 0.2,
    snippetLength: 16,
  }).find((hit) => hit.documentId === "prepared-fuzzy-anchor");
  assert.ok(tiny);
  assert.doesNotMatch(tiny.snippet, /retrievel/);
  assert.ok(tiny.snippet.replaceAll("…", "").length <= 16);
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

test("package API persists across fresh processes and preserves cache generations", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "okf-search-native-persistence-api-"));
  const sourceRoot = join(workspace, "source");
  const missingRoot = join(workspace, "source-removed");
  const cachePath = join(workspace, "nested", "cache", "collection.okf");
  try {
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(
      join(sourceRoot, "first.md"),
      markdown("note", "package-persistence-first"),
    );
    await writeFile(
      join(sourceRoot, "second.md"),
      markdown("guide", "package-persistence-second"),
    );

    const root = require("okf-search-native");
    const index = await root.openOkf(sourceRoot, { cachePath });
    assert.equal((await stat(cachePath)).isFile(), true);
    assert.equal(index.search("package-persistence-first", { match: "all" }).length, 1);
    assert.ok((await readdir(join(workspace, "nested", "cache")))
      .some((entry) => entry !== "collection.okf"));

    index.ingest({
      path: "saved.md",
      markdown: markdown("note", "package-persistence-saved"),
    });
    await index.save(cachePath);
    index.ingest({
      path: "unsaved.md",
      markdown: markdown("note", "package-persistence-unsaved"),
    });
    await rm(sourceRoot, { recursive: true, force: true });

    const freshReaderScript = `
      const assert = require("node:assert/strict");
      const { openOkf } = require(${JSON.stringify(join(packageRoot, "dist", "index.cjs"))});
      (async () => {
        const index = await openOkf(${JSON.stringify(missingRoot)}, {
          cachePath: ${JSON.stringify(cachePath)},
        });
        assert.equal(index.search("package-persistence-first", { match: "all" }).length, 1);
        assert.equal(index.search("package-persistence-first", { match: "all" })[0].path, "first.md");
        assert.equal(index.search("package-persistence-saved", { match: "all" }).length, 1);
        assert.equal(index.search("package-persistence-unsaved", { match: "all" }).length, 0);
        assert.equal(index.indexStats().logical.documents.total, 3);
        index.ingest({
          path: "child.md",
          markdown: "---\\ntype: child\\n---\\npackage-persistence-child\\n",
        });
        await index.save(${JSON.stringify(cachePath)});
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `;
    await execFileAsync(process.execPath, ["-e", freshReaderScript], {
      cwd: packageRoot,
      timeout: 10_000,
    });

    const afterChild = await root.openOkf(missingRoot, { cachePath });
    assert.equal(afterChild.search("package-persistence-child", { match: "all" }).length, 1);
    assert.equal(afterChild.search("package-persistence-unsaved", { match: "all" }).length, 0);

    const bytes = await readFile(cachePath);
    await writeFile(cachePath, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))));
    const corruptScript = `
      const assert = require("node:assert/strict");
      const { openOkf } = require(${JSON.stringify(join(packageRoot, "dist", "index.cjs"))});
      (async () => {
        await assert.rejects(
          openOkf(${JSON.stringify(missingRoot)}, { cachePath: ${JSON.stringify(cachePath)} }),
          (error) => error && error.code === "ERR_OKF_CACHE_INVALID" &&
            error.path === ${JSON.stringify(cachePath)},
        );
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `;
    await execFileAsync(process.execPath, ["-e", corruptScript], {
      cwd: packageRoot,
      timeout: 10_000,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("package API rejects overlapping writers and allows retry", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "okf-search-native-busy-api-"));
  const cachePath = join(workspace, "cache", "busy.okf");
  try {
    const root = require("okf-search-native");
    const index = root.createOkfSearch(
      Array.from({ length: 10 }, (_, document) => ({
        path: `document-${document}.md`,
        markdown: markdown(
          "note",
          `busy-package-marker-${document} ${"payload ".repeat(20_000)}`,
        ),
      })),
    );
    const results = await Promise.allSettled([
      index.save(cachePath),
      index.save(cachePath),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, "ERR_OKF_CACHE_BUSY");
    assert.equal(rejected[0].reason.path, cachePath);
    await index.save(cachePath);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("public child and worker APIs reject a held writer claim, read the old cache, and retry", { timeout: 660_000 }, async () => {
  // Reuse the Rust test-only pre-publication barrier. No timing race, addon
  // hook, or platform-specific external locking utility is needed.
  const { stdout } = await execFileAsync("cargo", [
    "test", "--locked", "--no-run", "--message-format=json",
  ], { cwd: packageRoot, timeout: 600_000, maxBuffer: 10 * 1024 * 1024 });
  const artifact = stdout.trim().split("\n").map((line) => JSON.parse(line))
    .find((message) => message.reason === "compiler-artifact" &&
      message.profile.test && message.executable);
  assert.ok(artifact?.executable, "Rust test executable must be available");
  const workspace = await mkdtemp(join(tmpdir(), "okf-public-writer-"));
  const cachePath = join(workspace, "cache.okf");
  const missingRoot = join(workspace, "missing");
  let holder;
  let holderExit;
  try {
    const { createOkfSearch } = require("okf-search-native");
    await createOkfSearch([{ path: "old.md", markdown: markdown("note", "oldgeneration") }]).save(cachePath);
    holder = spawn(artifact.executable, [
      "--exact", "persistence::tests::persistence_process_writer_helper", "--nocapture",
    ], {
      cwd: packageRoot,
      env: { ...process.env, OKF_TEST_CHILD_CACHE: cachePath },
      stdio: ["ignore", "pipe", "inherit"],
    });
    holderExit = once(holder, "exit");
    const lines = createInterface({ input: holder.stdout });
    const barrier = (async () => {
      for await (const line of lines) {
        if (line.includes("OKF_CHILD_BEFORE_PUBLISH")) return;
      }
      throw new Error("writer exited before publication barrier");
    })();
    let timer;
    try {
      await Promise.race([barrier, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("writer barrier timed out")), 15_000);
      })]);
    } finally {
      clearTimeout(timer);
      lines.close();
    }
    const script = (busy) => `
      const assert = require("node:assert/strict");
      const { createOkfSearch, openOkf, OkfError } = require("okf-search-native");
      (async () => {
        const cachePath = ${JSON.stringify(cachePath)};
        const loaded = await openOkf(${JSON.stringify(missingRoot)}, { cachePath });
        assert.equal(loaded.search("oldgeneration").length, 1);
        const writer = createOkfSearch([{ path: "old.md", markdown: "---\\ntype: note\\n---\\noldgeneration" }]);
        ${busy ? `await assert.rejects(writer.save(cachePath),
          error => error instanceof OkfError && error.code === "ERR_OKF_CACHE_BUSY" && error.path === cachePath);`
          : "await writer.save(cachePath);"}
      })()
    `;
    const runBoth = async (busy) => {
      await execFileAsync(process.execPath, ["-e", `${script(busy)}.catch(error => { console.error(error); process.exitCode = 1; });`], {
        cwd: packageRoot, timeout: 10_000,
      });
      const worker = new Worker(`${script(busy)}.catch(error => { throw error; });`, { eval: true });
      const timeout = setTimeout(() => { void worker.terminate(); }, 10_000);
      try {
        const [code] = await once(worker, "exit");
        assert.equal(code, 0);
      } finally {
        clearTimeout(timeout);
        await worker.terminate();
      }
    };
    await runBoth(true);
    holder.kill();
    await holderExit;
    holder = undefined;
    await runBoth(false);
  } finally {
    if (holder) {
      holder.kill();
      await holderExit;
    }
    await rm(workspace, { recursive: true, force: true });
  }
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
