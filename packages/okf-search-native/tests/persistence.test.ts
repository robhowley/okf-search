import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createOkfSearch,
  OkfError,
  openOkf,
} from "../src/index.js";
import type { OkfOpenOptions } from "../src/index.js";

const workspaces: string[] = [];

it("reports the same structured workspace initialization error on cache hit and miss", async () => {
  const { root, directory } = await workspace();
  const hit = join(directory, "hit.cache");
  const miss = join(directory, "miss.cache");
  const engine = await openOkf(root, { cachePath: hit });
  await engine.close();
  const blocked = join(directory, "not-a-directory");
  await writeFile(blocked, "blocked");
  // Isolate temporary-directory configuration from concurrent tests and Rust threads.
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { openOkf, OkfError } from ${JSON.stringify(new URL("../dist/index.mjs", import.meta.url).href)};
    const results = [];
    for (const cachePath of ${JSON.stringify([hit, miss])}) {
      try {
        const engine = await openOkf(${JSON.stringify(root)}, { cachePath, storage: "mmap" });
        await engine.close();
        throw new Error("expected workspace initialization failure");
      } catch (error) {
        results.push({ typed: error instanceof OkfError, code: error.code, path: error.path, cause: String(error.cause) });
      }
    }
    console.log(JSON.stringify(results));
  `], {
    env: { ...process.env, TMPDIR: blocked, TMP: blocked, TEMP: blocked },
    encoding: "utf8",
  });
  const errors = JSON.parse(output);
  for (const [index, path] of [hit, miss].entries()) {
    expect(errors[index]).toMatchObject({ typed: true, code: "ERR_OKF_WRITE", path });
    // tempfile Debug-formats the path, escaping Windows separators in the cause.
    expect(errors[index].cause).toContain(basename(blocked));
  }
});

function concept(metadata: string, body = "body"): string {
  return `---\n${metadata.trim()}\n---\n${body}\n`;
}

function cacheOptions(
  cachePath: string,
  storage: "memory" | "mmap",
): OkfOpenOptions {
  return storage === "mmap"
    ? { cachePath, storage: "mmap" }
    : { cachePath, storage: "memory" };
}

async function workspace(): Promise<{ root: string; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "okf-native-persistence-"));
  workspaces.push(directory);
  const root = join(directory, "source");
  await mkdir(root, { recursive: true });
  return { root, directory };
}

async function writeCollection(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise rejection");
}

function expectOkfError(
  error: unknown,
  code: string,
  path: string,
  field?: string,
): void {
  expect(error).toBeInstanceOf(OkfError);
  expect(error).toMatchObject({ code, path });
  if (field === undefined) {
    expect(Object.hasOwn(error as object, "field")).toBe(false);
  } else {
    expect(error).toMatchObject({ field });
  }
}

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "close reports the real retained mmap workspace after removal fails",
  async () => {
    const { root, directory } = await workspace();
    const temporary = join(directory, "native-tmp");
    await mkdir(temporary);
    const previousTmpdir = process.env.TMPDIR;
    let index: Awaited<ReturnType<typeof openOkf>> | undefined;
    let retained: string | undefined;
    let failed = false;
    try {
      // Isolate native workspaces so the expected path comes from disk, not the error.
      process.env.TMPDIR = temporary;
      index = await openOkf(root, {
        cachePath: join(directory, "cache.okf"), storage: "mmap",
      });
      const entries = await readdir(temporary);
      expect(entries).toHaveLength(1);
      retained = join(temporary, entries[0]!);
      expect((await stat(retained)).isDirectory()).toBe(true);
      // Deny unlinking children without interfering with worker shutdown or reads.
      await chmod(retained, 0o500);
      const close = index.close();
      expect(index.close()).toBe(close);
      const failure = await rejected(close);
      expectOkfError(failure, "ERR_OKF_CLOSE", retained);
      expect((await stat(retained)).isDirectory()).toBe(true);
      expect(index.close()).toBe(close);
      expect(await rejected(index.close())).toBe(failure);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
      const cleanupErrors: unknown[] = [];
      if (retained !== undefined) {
        await chmod(retained, 0o700).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") cleanupErrors.push(error);
        });
      }
      await index?.close().catch(() => {});
      await rm(temporary, { recursive: true, force: true }).catch((error: unknown) => {
        cleanupErrors.push(error);
      });
      // Keep the assertion failure primary, but fail an otherwise passing test on cleanup errors.
      if (!failed && cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, "Failed to clean up mmap workspace");
      }
    }
  },
);

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("public persistence lifecycle", () => {
  it("keeps no-cache opens in memory and publishes a missing cache before resolving", async () => {
    const { root, directory } = await workspace();
    await writeCollection(root, {
      "nested/source.md": concept("type: note", "no-cache-marker"),
    });
    const before = await readdir(root, { recursive: true });

    const inMemory = await openOkf(root);
    expect(inMemory.search("no-cache-marker")).toHaveLength(1);
    expect(await readdir(root, { recursive: true })).toEqual(before);

    const cachePath = join(directory, "nested", "cache", "index.okf");
    const cached = await openOkf(root, { cachePath });
    expect((await stat(cachePath)).isFile()).toBe(true);
    expect(cached.search("no-cache-marker")).toHaveLength(1);
    await expect(cached.save(cachePath)).resolves.toBeUndefined();
  });

  it("reads each open option getter once before delegating to native open", async () => {
    const { root, directory } = await workspace();
    await writeCollection(root, {
      "source.md": concept("type: note", "option-getter-marker"),
    });
    const cachePath = join(directory, "cache", "getter.okf");
    let cacheReads = 0;
    let storageReads = 0;
    const options = {
      get cachePath(): string {
        cacheReads += 1;
        return cachePath;
      },
      get storage(): "mmap" {
        storageReads += 1;
        return "mmap";
      },
    };

    const index = await openOkf(root, options);
    expect(cacheReads).toBe(1);
    expect(storageReads).toBe(1);
    expect(index.indexStats().storage.kind).toBe("mapped-index-files");
    expect(index.search("option-getter-marker")).toHaveLength(1);
    await index.close();
  });

  it("rejects invalid storage options without rebuilding or falling back", async () => {
    const { root } = await workspace();
    await writeCollection(root, {
      "source.md": concept("type: note", "strict-options-marker"),
    });

    expectOkfError(
      await rejected(openOkf(root, { storage: "mmap" })),
      "ERR_OKF_FIELD",
      "<input>",
      "cachePath",
    );
    expectOkfError(
      await rejected(openOkf(root, {
        storage: "unknown",
      } as unknown as OkfOpenOptions)),
      "ERR_OKF_FIELD",
      "<input>",
      "storage",
    );
  });

  it.each(["memory", "mmap"] as const)(
    "round-trips logical state, diagnostics, metadata, and empty-body documents (%s)",
    async (storage) => {
    const { root, directory } = await workspace();
    await writeCollection(root, {
      "strict.md": concept(
        `type: note
title: Persisted title
tags: [persisted]
status: stable
verified:
  - by: human:reviewer
    at: 2026-08-24T10:00:00Z
stale_after: 2027-01-01T00:00:00Z`,
        "roundtrip-marker",
      ),
      "degraded.md": concept(
        "type: guide\nstatus: future",
        "degraded-marker",
      ),
      "empty.md": concept("type: empty", ""),
    });

    const cachePath = join(directory, "cache", "collection.okf");
    const options = cacheOptions(cachePath, storage);
    const original = await openOkf(root, options);
    const logical = original.indexStats().logical;
    const hits = original.search("roundtrip-marker", {
      where: { tagsAny: ["persisted"], conformance: ["strict"] },
    });
    const degraded = original.listDegradedDocuments();

    const cached = await openOkf(join(directory, "source-was-removed"), options);
    expect(cached.indexStats().logical).toEqual(logical);
    expect(cached.search("roundtrip-marker", {
      where: { tagsAny: ["persisted"], conformance: ["strict"] },
    })).toEqual(hits);
    expect(cached.listDegradedDocuments()).toEqual(degraded);
    expect(cached.search("degraded-marker", { match: "all" })).toHaveLength(1);
    expect(cached.search("empty")).toEqual(original.search("empty"));
    expect(original.indexStats().storage.kind).toBe(
      storage === "mmap" ? "mapped-index-files" : "in-memory-index-files",
    );
    expect(cached.indexStats().logical.documents.total).toBe(3);
    await Promise.all([original.close(), cached.close()]);
    },
  );

  it.each(["memory", "mmap"] as const)(
    "saves handle mutations explicitly and captures before later mutations (%s)",
    async (storage) => {
    const { root, directory } = await workspace();
    await writeCollection(root, {
      "seed.md": concept("type: note", "seed-marker"),
    });
    const cachePath = join(directory, "cache", "mutations.okf");
    const options = cacheOptions(cachePath, storage);
    const index = await openOkf(root, options);

    index.ingest({
      path: "saved.md",
      markdown: concept("type: note", "saved-marker"),
    });
    await index.save(cachePath);
    index.ingest({
      path: "unsaved.md",
      markdown: concept("type: note", "unsaved-marker"),
    });

    const beforeSecondSave = await openOkf(join(directory, "missing-root"), options);
    expect(beforeSecondSave.search("saved-marker", { match: "all" })).toHaveLength(1);
    expect(beforeSecondSave.search("unsaved-marker", { match: "all" })).toEqual([]);

    const pending = beforeSecondSave.save(cachePath);
    beforeSecondSave.ingest({
      path: "after-capture.md",
      markdown: concept("type: note", "after-capture-marker"),
    });
    await pending;

    const captured = await openOkf(join(directory, "another-missing-root"), options);
    expect(captured.search("after-capture-marker", { match: "all" })).toEqual([]);
    await beforeSecondSave.save(cachePath);
    const afterSecondSave = await openOkf(join(directory, "final-missing-root"), options);
    expect(afterSecondSave.search("after-capture-marker", { match: "all" })).toHaveLength(1);

    expect(beforeSecondSave.remove("saved.md")).toBe(true);
    await beforeSecondSave.save(cachePath);
    const afterRemove = await openOkf(join(directory, "remove-missing-root"), options);
    expect(afterRemove.search("saved-marker", { match: "all" })).toEqual([]);
    expect(afterRemove.search("seed-marker", { match: "all" })).toHaveLength(1);
    await Promise.all([
      index.close(),
      beforeSecondSave.close(),
      captured.close(),
      afterSecondSave.close(),
      afterRemove.close(),
    ]);
    },
  );

  it("reopens the same archive across memory and mmap backends", async () => {
    const { directory } = await workspace();
    const cachePath = join(directory, "cache", "cross-backend.okf");
    const memory = createOkfSearch([{
      path: "memory.md",
      markdown: concept("type: note", "memory-generation-marker"),
    }]);
    await memory.save(cachePath);

    const mapped = await openOkf(join(directory, "missing-root"), {
      cachePath,
      storage: "mmap",
    });
    expect(mapped.indexStats().storage.kind).toBe("mapped-index-files");
    expect(mapped.search("memory-generation-marker")).toHaveLength(1);
    mapped.ingest({
      path: "mapped.md",
      markdown: concept("type: guide", "mappedonlymarker"),
    });
    await mapped.save(cachePath);

    const reopened = await openOkf(join(directory, "another-missing-root"), {
      cachePath,
      storage: "memory",
    });
    expect(reopened.indexStats().storage.kind).toBe("in-memory-index-files");
    expect(reopened.search("mappedonlymarker")).toHaveLength(1);
    await Promise.all([memory.close(), mapped.close(), reopened.close()]);
  });

  it("translates path errors and keeps a healthy handle after a cache write failure", async () => {
    const { root, directory } = await workspace();
    await writeCollection(root, {
      "source.md": concept("type: note", "healthy-marker"),
    });
    const index = await openOkf(root);

    const invalidOpen = await rejected(openOkf(root, { cachePath: "" }));
    expectOkfError(invalidOpen, "ERR_OKF_FIELD", "", "cachePath");

    const invalidSave = index.save("");
    expect(invalidSave).toBeInstanceOf(Promise);
    expectOkfError(
      await rejected(invalidSave),
      "ERR_OKF_FIELD",
      "",
      "path",
    );

    const nulPath = "invalid\0cache.okf";
    expectOkfError(
      await rejected(openOkf(root, { cachePath: nulPath })),
      "ERR_OKF_FIELD",
      nulPath,
      "cachePath",
    );
    expectOkfError(
      await rejected(index.save(nulPath)),
      "ERR_OKF_FIELD",
      nulPath,
      "path",
    );

    const surrogatePath = "\ud800-cache.okf";
    expectOkfError(
      await rejected(openOkf(root, { cachePath: surrogatePath })),
      "ERR_OKF_FIELD",
      "<input>",
      "cachePath",
    );
    expectOkfError(
      await rejected(index.save(surrogatePath)),
      "ERR_OKF_FIELD",
      "<input>",
      "path",
    );

    const existingDirectory = join(directory, "existing-cache-directory");
    await mkdir(existingDirectory);
    expectOkfError(
      await rejected(openOkf(join(directory, "missing-root"), {
        cachePath: existingDirectory,
      })),
      "ERR_OKF_READ",
      existingDirectory,
    );

    const blockedParent = join(directory, "not-a-directory");
    await writeFile(blockedParent, "blocking entry");
    const blockedDestination = join(blockedParent, "cache.okf");
    const writeFailure = await rejected(index.save(blockedDestination));
    expectOkfError(writeFailure, "ERR_OKF_WRITE", blockedDestination);
    expect(index.search("healthy-marker")).toHaveLength(1);

    const validCache = join(directory, "cache", "healthy.okf");
    await index.save(validCache);
    expect((await stat(validCache)).isFile()).toBe(true);
  });

  it.each(["memory", "mmap"] as const)(
    "rejects an existing corrupt cache without rebuilding from the source root (%s)",
    async (storage) => {
      const { root, directory } = await workspace();
      await writeCollection(root, {
        "source.md": concept("type: note", "corruption-marker"),
      });
      const cachePath = join(directory, "cache", "corruptible.okf");
      const options = cacheOptions(cachePath, storage);
      const index = await openOkf(root, options);
      const bytes = await readFile(cachePath);
      await writeFile(cachePath, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))));
      await index.close();

      const error = await rejected(openOkf(join(directory, "source-is-missing"), options));
      expectOkfError(error, "ERR_OKF_CACHE_INVALID", cachePath);
      expect((error as Error).message).not.toMatch(/source-is-missing/);
    },
  );

  it.each([
    ["memory", 1],
    ["memory", 2],
    ["mmap", 1],
    ["mmap", 2],
  ] as const)(
    "rejects unsupported archive versions in %s storage (%s)",
    async (storage, format) => {
    const { root, directory } = await workspace();
    await writeCollection(root, {
      "source.md": concept("type: note", "old-format-marker"),
    });
    const cachePath = join(directory, "old.okf");
    // Unsupported versions reject before decoding their differently shaped metadata.
    const old = Buffer.alloc(60);
    old.write("OKFCACHE");
    old.writeUInt32LE(format, 8);
    old.writeBigUInt64LE(2n, 12);
    old.write("{}", 20);
    await writeFile(cachePath, old);
    const options = cacheOptions(cachePath, storage);
    expectOkfError(await rejected(openOkf(root, options)),
      "ERR_OKF_CACHE_INCOMPATIBLE", cachePath);
    expect(await readFile(cachePath)).toEqual(old);
  });

  it("publishes whole generations while cached readers run concurrently", async () => {
    const { directory } = await workspace();
    const cachePath = join(directory, "cache", "atomic.okf");
    const index = createOkfSearch([
      {
        path: "first.md",
        markdown: concept("type: note", "generationalpha"),
      },
      {
        path: "second.md",
        markdown: concept("type: note", "generationalpha"),
      },
    ]);
    await index.save(cachePath);

    const readGeneration = async (): Promise<void> => {
      const reader = await openOkf(join(directory, "no-source"), { cachePath });
      const alpha = reader.search("generationalpha", { match: "all" }).length;
      const beta = reader.search("generationbeta", { match: "all" }).length;
      expect([[2, 0], [0, 2]]).toContainEqual([alpha, beta]);
    };

    const writer = (async (): Promise<void> => {
      for (let iteration = 0; iteration < 6; iteration += 1) {
        const marker = iteration % 2 === 0 ? "generationbeta" : "generationalpha";
        for (const path of ["first.md", "second.md"]) {
          index.ingest({
            path,
            markdown: concept("type: note", marker),
          });
        }
        await index.save(cachePath);
      }
    })();
    const readers = Promise.all(
      Array.from({ length: 12 }, async () => {
        for (let iteration = 0; iteration < 4; iteration += 1) {
          await readGeneration();
        }
      }),
    );

    await Promise.all([writer, readers]);
  });

});
