import { describe, expect, it } from "vitest";

import { NativeOkfSearch } from "../native.cjs";
import { createOkfSearch, OkfError } from "../src/index.js";

function concept(metadata: string, body = "body"): string {
  return `---\n${metadata.trim()}\n---\n${body}\n`;
}

function thrownBy(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error("Expected call to throw");
}

describe("friendly root lifecycle", () => {
  it("creates an empty mutable handle", () => {
    const index = createOkfSearch([]);
    expect(index.listTypes()).toEqual([]);
    expect(index.listDegradedDocuments()).toEqual([]);
    expect(index.search("anything")).toEqual([]);
    expect(index.indexStats()).toMatchObject({
      logical: {
        documents: { total: 0, strict: 0, degraded: 0 },
        types: [],
        statuses: {
          draft: 0,
          stable: 0,
          deprecated: 0,
          unclassified: 0,
        },
        trustTiers: {
          unverified: 0,
          machineConfirmed: 0,
          humanReviewed: 0,
          unclassified: 0,
        },
      },
      storage: { kind: "in-memory-index-files" },
    });
    expect(index.remove("missing.md")).toBe(false);
    expect(() => index.autoSuggest("anything")).toThrowError(
      new OkfError("ERR_OKF_UNSUPPORTED", "autoSuggest"),
    );
  });

  it("prepares a normalized batch before native construction", () => {
    const index = createOkfSearch([
      {
        path: "z.md",
        markdown: concept("type: strict", "strictneedle"),
      },
      {
        path: "./nested//a.md",
        markdown: concept("type: degraded\ntitle: 1", "degradedneedle"),
      },
    ]);

    expect(index.listTypes()).toEqual(["degraded", "strict"]);
    expect(index.listDegradedDocuments()).toEqual([
      expect.objectContaining({ documentId: "nested/a", path: "nested/a.md" }),
    ]);

    expect(() => createOkfSearch([
      { path: "./same//guide.md", markdown: concept("type: note") },
      { path: "same/guide.md", markdown: "not frontmatter" },
    ])).toThrowError(expect.objectContaining({
      code: "ERR_OKF_FIELD",
      path: "same/guide.md",
      field: "path",
    }));

    expect(() => createOkfSearch([
      { path: "fatal.md", markdown: concept("type: ' '") },
    ])).toThrowError(expect.objectContaining({
      code: "ERR_OKF_FIELD",
      path: "fatal.md",
      field: "type",
    }));
  });

  it("replaces aliases atomically and keeps returned source metadata detached", () => {
    const index = createOkfSearch([{
      path: "seed.md",
      markdown: concept("type: seed", "seedneedle"),
    }]);
    const input = {
      path: "./a//b.md",
      markdown: concept("type: note\ntags: [kept]", "oldneedle"),
    };
    const added = index.ingest(input);

    input.path = "changed.md";
    input.markdown = concept("type: changed", "changedneedle");
    expect(added.conformance).toBe("strict");
    if (added.conformance !== "strict") throw new Error("expected strict result");
    added.document.tags[0] = "caller-change";

    expect(index.search("oldneedle", { where: { tagsAny: ["kept"] } }))
      .toEqual([expect.objectContaining({ documentId: "a/b", path: "a/b.md" })]);
    expect(index.search("oldneedle", { where: { tagsAny: ["caller-change"] } }))
      .toEqual([]);
    expect(index.search("changedneedle")).toEqual([]);
    const beforeFailedReplacement = index.indexStats();

    expect(() => index.ingest({
      path: "a/./b.md",
      markdown: concept("title: broken", "replacementneedle"),
    })).toThrowError(expect.objectContaining({
      code: "ERR_OKF_FIELD",
      path: "a/b.md",
      field: "type",
    }));
    expect(index.search("oldneedle")).toHaveLength(1);
    expect(index.search("replacementneedle")).toEqual([]);
    expect(index.indexStats().logical).toEqual(beforeFailedReplacement.logical);

    const replacement = index.ingest({
      path: "a/./b.md",
      markdown: concept("type: replacement", "newneedle"),
    });
    expect(replacement.conformance).toBe("strict");
    expect(index.search("oldneedle")).toEqual([]);
    expect(index.search("newneedle")).toHaveLength(1);
    expect(index.listTypes()).toEqual(["replacement", "seed"]);
    expect(index.indexStats().logical.types).toEqual([
      { type: "replacement", documentCount: 1 },
      { type: "seed", documentCount: 1 },
    ]);
  });

  it("returns sorted detached inventories and removes all committed state", () => {
    const index = createOkfSearch([]);
    for (const path of ["z.md", "./a//nested.md", "A.md"]) {
      index.ingest({
        path,
        markdown: concept(
          "type: degraded\nstatus: future",
          path.includes("nested") ? "nestedremovedneedle" : `${path} inventoryneedle`,
        ),
      });
    }

    const first = index.listDegradedDocuments();
    const firstTypes = index.listTypes();
    expect(first.map((document) => document.path)).toEqual([
      "A.md",
      "a/nested.md",
      "z.md",
    ]);
    expect(firstTypes).toEqual(["degraded"]);

    first[0]!.diagnostics[0]!.message = "caller mutation";
    Array.prototype.push.call(first, first[0]);
    Array.prototype.push.call(firstTypes, "caller mutation");
    const second = index.listDegradedDocuments();
    expect(second).not.toBe(first);
    expect(second[0]).not.toBe(first[0]);
    expect(second[0]!.diagnostics).not.toBe(first[0]!.diagnostics);
    expect(second[0]!.diagnostics[0]!.message).toBe(
      "Invalid OKF field: A.md (status)",
    );
    expect(index.listTypes()).toEqual(["degraded"]);

    expect(index.remove("./a//nested.md")).toBe(true);
    expect(index.remove("a/nested.md")).toBe(false);
    expect(index.search("nestedremovedneedle")).toEqual([]);
    expect(index.listDegradedDocuments().map((document) => document.path))
      .toEqual(["A.md", "z.md"]);
  });

  it("maps preparation failures publicly without poisoning a usable handle", () => {
    const index = createOkfSearch([{
      path: "seed.md",
      markdown: concept("type: note", "usableaftererror"),
    }]);
    const failure = thrownBy(() => index.ingest({
      path: "broken.md",
      markdown: "not frontmatter",
    }));

    expect(failure).toBeInstanceOf(OkfError);
    expect(failure).toMatchObject({
      name: "OkfError",
      code: "ERR_OKF_PARSE",
      path: "broken.md",
    });
    expect((failure as Error).message).not.toMatch(/PrepareError|ERR_OKF_INVALID_/);
    expect(index.search("usableaftererror")).toHaveLength(1);
  });

  it("caches one public poison error before every later method", () => {
    const index = createOkfSearch([{
      path: "present.md",
      markdown: concept("type: note", "presentneedle"),
    }]);
    const prototype = NativeOkfSearch.prototype;
    const originals = {
      ingest: prototype.ingestPrepared,
      search: prototype.search,
      stats: prototype.indexStats,
      types: prototype.listTypes,
      degraded: prototype.listDegradedDocuments,
      remove: prototype.removeDocument,
    };
    const calls = {
      ingest: 0,
      search: 0,
      stats: 0,
      types: 0,
      degraded: 0,
      remove: 0,
    };

    prototype.ingestPrepared = function () {
      calls.ingest += 1;
      throw new Error("[ERR_OKF_INDEX_UNUSABLE] injected native failure");
    };
    prototype.search = function (...args) {
      calls.search += 1;
      return originals.search.apply(this, args);
    };
    prototype.indexStats = function () {
      calls.stats += 1;
      return originals.stats.call(this);
    };
    prototype.listTypes = function () {
      calls.types += 1;
      return originals.types.call(this);
    };
    prototype.listDegradedDocuments = function () {
      calls.degraded += 1;
      return originals.degraded.call(this);
    };
    prototype.removeDocument = function (...args) {
      calls.remove += 1;
      return originals.remove.apply(this, args);
    };

    try {
      const first = thrownBy(() => index.ingest({
        path: "./failed//mutation.md",
        markdown: concept("type: note", "failedneedle"),
      }));
      expect(first).toBeInstanceOf(OkfError);
      expect(first).toMatchObject({
        code: "ERR_OKF_INDEX_UNUSABLE",
        path: "failed/mutation.md",
        message: "Search index failed while mutating failed/mutation.md; this OkfSearch handle is permanently unusable and must be rebuilt",
      });
      expect((first as Error).message).not.toMatch(/\[ERR_|napi|native/i);

      for (const call of [
        () => index.ingest({ path: "bad", markdown: "bad" }),
        () => index.listDegradedDocuments(),
        () => index.indexStats(),
        () => index.listTypes(),
        () => index.remove("bad"),
        () => index.search("", { limit: -1 }),
        () => index.autoSuggest("present", { limit: -1 }),
      ]) {
        expect(thrownBy(call)).toBe(first);
      }

      expect(calls).toEqual({
        ingest: 1,
        search: 0,
        stats: 0,
        types: 0,
        degraded: 0,
        remove: 0,
      });
    } finally {
      prototype.ingestPrepared = originals.ingest;
      prototype.search = originals.search;
      prototype.indexStats = originals.stats;
      prototype.listTypes = originals.types;
      prototype.listDegradedDocuments = originals.degraded;
      prototype.removeDocument = originals.remove;
    }
  });

  it("sanitizes non-poison native marker errors without poisoning", () => {
    const index = createOkfSearch([{
      path: "present.md",
      markdown: concept("type: note", "presentneedle"),
    }]);
    const prototype = NativeOkfSearch.prototype;
    const original = prototype.search;
    let calls = 0;
    prototype.search = function (...args) {
      calls += 1;
      if (calls === 1) {
        throw new Error("[ERR_OKF_INVALID_SEARCH_OPTIONS] injected invalid option");
      }
      if (calls === 2) {
        throw new Error("[ERR_OKF_NATIVE] injected backend error");
      }
      return original.apply(this, args);
    };

    try {
      const invalid = thrownBy(() => index.search("presentneedle"));
      expect(invalid).toBeInstanceOf(TypeError);
      expect((invalid as Error).message).toBe("injected invalid option");

      const native = thrownBy(() => index.search("presentneedle"));
      expect(native).toBeInstanceOf(Error);
      expect(native).not.toBeInstanceOf(OkfError);
      expect((native as Error).message).toBe("injected backend error");

      expect(index.search("presentneedle")).toHaveLength(1);
    } finally {
      prototype.search = original;
    }
  });
});
