import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createOkfSearch,
  openOkf,
  validateOkfDocument,
} from "../src/index.js";
import type { OkfSearchOptions } from "../src/index.js";

function concept(metadata: string, body = "body"): string {
  return `---\n${metadata.trim()}\n---\n${body}\n`;
}

describe("validateOkfDocument", () => {
  it("returns strict, degraded, and fatal results without throwing", () => {
    expect(validateOkfDocument({
      path: "strict.md",
      markdown: concept("type: note"),
    })).toEqual({ isValid: true, isIndexable: true, errors: [] });

    expect(validateOkfDocument({
      path: "degraded.md",
      markdown: concept("type: note\nstatus: future"),
    })).toEqual({
      isValid: false,
      isIndexable: true,
      errors: [expect.objectContaining({
        code: "ERR_OKF_FIELD",
        path: "degraded.md",
        field: "status",
      })],
    });

    expect(() => validateOkfDocument({
      path: "../unsafe.md",
      markdown: "not frontmatter",
    })).not.toThrow();
    expect(validateOkfDocument({
      path: "../unsafe.md",
      markdown: "not frontmatter",
    })).toEqual({
      isValid: false,
      isIndexable: false,
      errors: [expect.objectContaining({
        code: "ERR_OKF_FIELD",
        path: "<input>",
        field: "path",
      })],
    });
  });

  it("returns fresh detached diagnostics", () => {
    const input = {
      path: "degraded.md",
      markdown: concept("type: note\nstatus: future"),
    };
    const first = validateOkfDocument(input);
    const second = validateOkfDocument(input);

    expect(first).not.toBe(second);
    expect(first.errors).not.toBe(second.errors);
    first.errors[0]!.message = "caller mutation";
    expect(second.errors[0]!.message).toBe(
      "Invalid OKF field: degraded.md (status)",
    );
  });
});

describe("friendly search behavior", () => {
  it("uses mapped storage for root opens and rejects work after close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "okf-native-root-contract-"));
    const root = join(directory, "source");
    const cachePath = join(directory, "cache", "index.okf");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "mapped.md"), concept("type: note", "mapped-marker"));

    try {
      const index = await openOkf(root, { cachePath, storage: "mmap" });
      expect(index.search("mapped-marker")).toHaveLength(1);
      expect(index.indexStats().storage).toMatchObject({
        kind: "mapped-index-files",
      });
      expect(index.indexStats().storage.sizeInBytes).toBeGreaterThan(0);

      await index.close();
      expect(() => index.indexStats()).toThrowError(expect.objectContaining({
        code: "ERR_OKF_INDEX_CLOSED",
      }));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports one logical document per state with every stats family", () => {
    const index = createOkfSearch([
      {
        path: "draft-machine.md",
        markdown: concept(
          "type: Note\nstatus: draft\nverified:\n  by: process:builder\n  at: 2026-08-24T10:00:00Z",
          "draft machine",
        ),
      },
      {
        path: "stable-human.md",
        markdown: concept(
          "type: note\nstatus: stable\nverified:\n  by: human:reviewer\n  at: 2026-08-24T10:00:00Z",
          "stable human",
        ),
      },
      {
        path: "deprecated-unverified.md",
        markdown: concept(
          "type: Note\nstatus: deprecated",
          "deprecated unverified",
        ),
      },
      {
        path: "unclassified-status.md",
        markdown: concept(
          "type: Note\nstatus: future\nverified:\n  by: human:reviewer\n  at: 2026-08-24T10:00:00Z",
          "unclassified status",
        ),
      },
      {
        path: "unclassified-trust.md",
        markdown: concept(
          "type: Guide\nstatus: stable\nverified: malformed",
          "unclassified trust",
        ),
      },
    ]);

    const stats = index.indexStats();
    expect(stats).toMatchObject({
      logical: {
        documents: { total: 5, strict: 3, degraded: 2 },
        types: [
          { type: "Guide", documentCount: 1 },
          { type: "Note", documentCount: 3 },
          { type: "note", documentCount: 1 },
        ],
        statuses: {
          draft: 1,
          stable: 2,
          deprecated: 1,
          unclassified: 1,
        },
        trustTiers: {
          unverified: 1,
          machineConfirmed: 1,
          humanReviewed: 2,
          unclassified: 1,
        },
      },
      storage: {
        kind: "in-memory-index-files",
      },
    });
    expect(Object.keys(stats).sort()).toEqual(["logical", "storage"]);
    expect(Object.keys(stats.logical).sort()).toEqual([
      "documents",
      "statuses",
      "trustTiers",
      "types",
    ]);
    expect(Object.keys(stats.storage).sort()).toEqual([
      "kind",
      "sizeInBytes",
    ]);
    expect(stats.storage.kind).toBe("in-memory-index-files");
    if (stats.storage.kind === "in-memory-index-files") {
      expect(Number.isSafeInteger(stats.storage.sizeInBytes)).toBe(true);
      expect(stats.storage.sizeInBytes).toBeGreaterThan(0);
    }
  });

  it("returns detached recursively frozen index stats", () => {
    const index = createOkfSearch([{
      path: "stats.md",
      markdown: concept("type: note", "stats needle"),
    }]);

    const first = index.indexStats();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.logical)).toBe(true);
    expect(Object.isFrozen(first.logical.documents)).toBe(true);
    expect(Object.isFrozen(first.logical.types)).toBe(true);
    expect(Object.isFrozen(first.logical.types[0])).toBe(true);
    expect(Object.isFrozen(first.logical.statuses)).toBe(true);
    expect(Object.isFrozen(first.logical.trustTiers)).toBe(true);
    expect(Object.isFrozen(first.storage)).toBe(true);

    const mutable = first as unknown as {
      logical: {
        documents: { total: number };
        types: Array<{ documentCount: number }>;
      };
    };
    expect(() => {
      mutable.logical.documents.total = 99;
    }).toThrow(TypeError);
    expect(() => {
      mutable.logical.types[0]!.documentCount = 99;
    }).toThrow(TypeError);

    const second = index.indexStats();
    expect(second).not.toBe(first);
    expect(second.logical).not.toBe(first.logical);
    expect(second.logical.documents).not.toBe(first.logical.documents);
    expect(second.logical.types).not.toBe(first.logical.types);
    expect(second.logical.types[0]).not.toBe(first.logical.types[0]);
    expect(second.storage).not.toBe(first.storage);
    expect(second.logical.documents.total).toBe(1);
  });

  it("keeps stats across failed mutations and updates them after success", () => {
    const index = createOkfSearch([{
      path: "seed.md",
      markdown: concept("type: note", "seed needle"),
    }]);
    const initial = index.indexStats();

    expect(() => index.ingest({
      path: "failed.md",
      markdown: concept("status: stable", "failed needle"),
    })).toThrowError(expect.objectContaining({
      code: "ERR_OKF_FIELD",
      field: "type",
    }));
    expect(index.indexStats().logical).toEqual(initial.logical);

    index.ingest({
      path: "added.md",
      markdown: concept("type: guide\nstatus: deprecated", "added needle"),
    });
    expect(index.indexStats().logical.documents).toEqual({
      total: 2,
      strict: 2,
      degraded: 0,
    });
    expect(index.indexStats().logical.types).toEqual([
      { type: "guide", documentCount: 1 },
      { type: "note", documentCount: 1 },
    ]);

    expect(index.remove("added.md")).toBe(true);
    expect(index.indexStats().logical.documents).toEqual(initial.logical.documents);
  });

  it("supports any/all, field selection, final-term prefix, and fuzzy matching", () => {
    const index = createOkfSearch([
      {
        path: "full.md",
        markdown: concept(
          "type: note\ntitle: titleonlyneedle recovery",
          "matchalpha matchbeta rollback procedure",
        ),
      },
      {
        path: "partial.md",
        markdown: concept("type: note", "matchalpha"),
      },
    ]);

    expect(index.search("matchalpha matchbeta", { match: "any" })
      .map((hit) => hit.documentId).sort()).toEqual(["full", "partial"]);
    expect(index.search("matchalpha matchbeta", { match: "all" })
      .map((hit) => hit.documentId)).toEqual(["full"]);
    expect(index.search("titleonlyneedle", { fields: ["body"] })).toEqual([]);
    expect(index.search("titleonlyneedle", { fields: ["title"] }))
      .toHaveLength(1);
    expect(index.search("rollback proce", { match: "all", fields: ["body"] }))
      .toHaveLength(1);
    expect(index.search("rollbak", { fields: ["body"] })).toEqual([]);
    expect(index.search("rollbak", { fields: ["body"], fuzzy: 0.2 }))
      .toHaveLength(1);
  });

  it("anchors fuzzy snippets on analyzed body tokens and preserves token boundaries", () => {
    const index = createOkfSearch([
      {
        path: "fuzzy-anchor.md",
        markdown: concept(
          "type: note",
          `${"introduction ".repeat(20)} retrievel ${"filler ".repeat(60)} retrieval`,
        ),
      },
      {
        path: "prefix-anchor.md",
        markdown: concept(
          "type: note",
          `${"introduction ".repeat(20)} apropos ${"filler ".repeat(50)} profile`,
        ),
      },
    ]);

    const fuzzy = index.search("rexrieval", {
      fields: ["body"],
      fuzzy: 0.2,
      snippetLength: 240,
    }).find((hit) => hit.documentId === "fuzzy-anchor");
    expect(fuzzy).toBeDefined();
    expect(fuzzy!.snippet).toContain("retrievel");
    expect(fuzzy!.snippet).not.toContain("retrieval");
    expect(index.search("rexrieval", {
      fields: ["body"],
      fuzzy: false,
    })).toEqual([]);
    expect(index.search("rexrieval", {
      fields: ["body"],
      fuzzy: 0,
    })).toEqual([]);

    const prefix = index.search("pro", {
      fields: ["body"],
      fuzzy: false,
      snippetLength: 240,
    }).find((hit) => hit.documentId === "prefix-anchor");
    expect(prefix).toBeDefined();
    expect(prefix!.snippet).toContain("profile");
    expect(prefix!.snippet).not.toContain("apropos");
    expect(index.search("pr", {
      fields: ["body"],
      fuzzy: false,
    })).toEqual([]);
  });

  it("anchors across fields and uses original Unicode body offsets", () => {
    const unicodeBody = `${"中".repeat(100)} İstanbul 😀 retrieval ${"z".repeat(250)}`;
    const excludedBody = `${"leading ".repeat(80)} excludedneedle`;
    const index = createOkfSearch([
      {
        path: "unicode-anchor.md",
        markdown: concept("type: note", unicodeBody),
      },
      {
        path: "cross-field.md",
        markdown: concept(
          "type: note\ntitle: titlealpha",
          `${"introduction ".repeat(20)} retrieval`,
        ),
      },
      {
        path: "body-excluded.md",
        markdown: concept("type: note\ntitle: excludedneedle", excludedBody),
      },
    ]);

    const unicode = index.search("rexrieval", {
      fields: ["body"],
      fuzzy: 0.2,
      snippetLength: 240,
    }).find((hit) => hit.documentId === "unicode-anchor");
    expect(unicode?.snippet).toBe(
      `…${"中".repeat(67)} İstanbul 😀 retrieval ${"z".repeat(150)}…`,
    );

    for (const match of ["any", "all"] as const) {
      const hit = index.search("titlealpha rexrieval", {
        fields: ["title", "body"],
        fuzzy: 0.2,
        match,
        snippetLength: 240,
      }).find((candidate) => candidate.documentId === "cross-field");
      expect(hit).toBeDefined();
      expect(hit!.snippet).toContain("retrieval");
      expect(hit!.matchedFields).toEqual(["title", "body"]);
    }

    const bodyExcluded = index.search("excludedneedle", {
      fields: ["title"],
      snippetLength: 32,
    }).find((hit) => hit.documentId === "body-excluded");
    expect(bodyExcluded).toBeDefined();
    expect(bodyExcluded!.snippet).toMatch(/^leading/);
    expect(bodyExcluded!.snippet).not.toContain("excludedneedle");
  });

  it("preserves the fixed lookbehind when a tiny budget hides a late anchor", () => {
    const index = createOkfSearch([{
      path: "tiny-anchor.md",
      markdown: concept(
        "type: note",
        `${"lead ".repeat(30)} retrieval ${"tail ".repeat(20)}`,
      ),
    }]);

    const wide = index.search("rexrieval", {
      fields: ["body"],
      fuzzy: 0.2,
      snippetLength: 240,
    })[0]!;
    const tiny = index.search("rexrieval", {
      fields: ["body"],
      fuzzy: 0.2,
      snippetLength: 16,
    })[0]!;

    expect(wide.snippet).toContain("retrieval");
    expect(tiny.snippet).not.toContain("retrieval");
    expect(tiny.snippet.replaceAll("…", "").length).toBeLessThanOrEqual(16);
  });

  it("configures UTF-16 snippet windows without changing result ordering", () => {
    const longBody = `prefix snippetneedle ${"x".repeat(252)} larger-only`;
    const index = createOkfSearch([
      {
        path: "long.md",
        markdown: concept("type: note", longBody),
      },
      {
        path: "other.md",
        markdown: concept("type: note", "snippetneedle other"),
      },
    ]);
    const order = (options?: OkfSearchOptions) =>
      index.search("snippetneedle", options)
        .map(({ documentId, score }) => ({ documentId, score }));
    const omitted = index.search("snippetneedle");
    const explicitDefault = index.search("snippetneedle", {
      snippetLength: 240,
    });
    const shorter = index.search("snippetneedle", { snippetLength: 32 });
    const longer = index.search("snippetneedle", { snippetLength: 300 });

    expect(explicitDefault).toEqual(omitted);
    expect(shorter.find((hit) => hit.documentId === "long")?.snippet)
      .toBe(`prefix snippetneedle ${"x".repeat(11)}…`);
    expect(longer.find((hit) => hit.documentId === "long")?.snippet)
      .toContain("larger-only");
    const shorterText = shorter.find((hit) => hit.documentId === "long")!.snippet
      .replace("…", "");
    expect(shorterText.length).toBeLessThanOrEqual(32);
    expect(Buffer.byteLength(shorterText)).toBeLessThanOrEqual(32);
    expect(order({ snippetLength: 32 })).toEqual(order());
    expect(order({ snippetLength: 300 })).toEqual(order());
  });

  it("measures snippet windows in UTF-16 units at scalar boundaries", () => {
    const index = createOkfSearch([{
      path: "unicode.md",
      markdown: concept("type: note", `ééééé needle尾${"z".repeat(20)}`),
    }]);
    const hit = index.search("needle", { snippetLength: 18 })[0]!;
    const text = hit.snippet.replace("…", "");

    expect(hit.snippet).toBe(`ééééé needle尾${"z".repeat(5)}…`);
    expect(text.length).toBe(18);
    expect(Buffer.byteLength(text)).toBeGreaterThan(18);
    expect(hit.snippet).not.toContain("\uFFFD");
  });

  it("counts CJK, emoji, and combining marks as UTF-16 units", () => {
    const index = createOkfSearch([
      {
        path: "cjk.md",
        markdown: concept("type: note", `needle${"中".repeat(300)}`),
      },
      {
        path: "emoji.md",
        markdown: concept("type: note", "needle a😀z"),
      },
      {
        path: "combining.md",
        markdown: concept("type: note", "needle e\u0301x"),
      },
    ]);

    const cjk = index.search("needle", {
      fields: ["body"],
      snippetLength: 240,
    }).find((hit) => hit.documentId === "cjk")!.snippet;
    expect(cjk.replace("…", "")).toBe(`needle${"中".repeat(234)}`);
    expect(cjk.replace("…", "").length).toBe(240);

    const emoji = index.search("needle", {
      fields: ["body"],
      snippetLength: 7,
    }).find((hit) => hit.documentId === "emoji")!.snippet;
    expect(emoji).toBe("needle…");
    expect(emoji.replace("…", "").length).toBe(6);

    const combining = index.search("needle", {
      fields: ["body"],
      snippetLength: 9,
    }).find((hit) => hit.documentId === "combining")!.snippet;
    expect(combining).toBe("needle é…");
    expect(combining.replace("…", "").length).toBe(9);
  });

  it("uses odd UTF-16 budgets without splitting emoji", () => {
    const index = createOkfSearch([{
      path: "emoji-budget.md",
      markdown: concept("type: note", "a😀z"),
    }]);

    expect(index.search("a", {
      fields: ["body"],
      snippetLength: 1,
    })[0]!.snippet).toBe("a…");
    expect(index.search("a", {
      fields: ["body"],
      snippetLength: 3,
    })[0]!.snippet).toBe("a😀…");
  });

  it("keeps exact matches after non-ASCII lookbehind and leaves ellipses extra", () => {
    const body = `${"中".repeat(100)} needle ${"x".repeat(200)}`;
    const index = createOkfSearch([{
      path: "lookbehind.md",
      markdown: concept("type: note", body),
    }]);
    const hit = index.search("needle", {
      fields: ["body"],
      snippetLength: 240,
    })[0]!;

    expect(hit.snippet).toContain("needle");
    expect(hit.snippet.startsWith("…")).toBe(true);
    expect(hit.snippet.endsWith("…")).toBe(true);
    expect(hit.snippet.length).toBe(242);
    expect(hit.snippet.replaceAll("…", "").length).toBe(240);
  });

  it("supports boosts without asserting cross-engine score parity", () => {
    const term = "boostneedle";
    const index = createOkfSearch([
      {
        path: "title.md",
        markdown: concept(`type: note\ntitle: ${term}`, "control filler"),
      },
      {
        path: "body.md",
        markdown: concept("type: note\ntitle: control filler", term),
      },
    ]);

    expect(index.search(term, {
      fields: ["title", "body"],
      boost: { body: 10, title: 0.1 },
    })[0]?.documentId).toBe("body");
    expect(index.search(term, {
      fields: ["title", "body"],
      boost: { body: 0.1, title: 10 },
    })[0]?.documentId).toBe("title");
  });

  it("filters before limit across metadata, staleness, and conformance", () => {
    const at = new Date("2026-08-24T12:00:00Z");
    const index = createOkfSearch([
      {
        path: "degraded.md",
        markdown: concept(
          "type: note\ntitle: filterneedle\ntags: [target]\nstatus: stable\ndescription: {broken: true}\nverified:\n  by: human:alice\n  at: 2026-08-24T10:00:00Z\nstale_after: 2026-08-24T13:00:00Z",
          "first",
        ),
      },
      {
        path: "strict.md",
        markdown: concept(
          "type: recipe\ntitle: ordinary\ntags: [target]\nstatus: draft\nverified:\n  by: process:builder\n  at: 2026-08-24T10:00:00Z\nstale_after: 2026-08-24T11:00:00Z",
          "filterneedle",
        ),
      },
    ]);

    expect(index.search("filterneedle", {
      limit: 1,
      asOf: at,
      where: {
        types: ["recipe"],
        tagsAny: ["target"],
        statuses: ["draft"],
        trustTiers: ["machine-confirmed"],
        stale: true,
        conformance: ["strict"],
      },
    })).toEqual([
      expect.objectContaining({ documentId: "strict", conformance: "strict" }),
    ]);
    expect(index.search("filterneedle", {
      where: { conformance: ["degraded"] },
    })).toEqual([
      expect.objectContaining({ documentId: "degraded", conformance: "degraded" }),
    ]);
  });

  it("collapses sections to one document and returns detached result envelopes", () => {
    const index = createOkfSearch([{
      path: "sections.md",
      markdown: concept(
        "type: note\ntitle: collapseenvelope",
        "# First\ncollapseenvelope\n\n# Second\ncollapseenvelope",
      ),
    }]);

    const first = index.search("collapseenvelope", { limit: 10 });
    expect(first).toHaveLength(1);
    expect(Object.keys(first[0]!).sort()).toEqual([
      "conformance",
      "documentId",
      "endLine",
      "headingPath",
      "matchedFields",
      "path",
      "score",
      "sectionId",
      "snippet",
      "startLine",
      "title",
    ]);
    expect(first[0]).toMatchObject({
      documentId: "sections",
      path: "sections.md",
      conformance: "strict",
      matchedFields: expect.any(Array),
      startLine: expect.any(Number),
      endLine: expect.any(Number),
      snippet: expect.any(String),
    });

    first[0]!.matchedFields.push("body");
    first[0]!.title = "caller mutation";
    const second = index.search("collapseenvelope", { limit: 10 });
    expect(second).not.toBe(first);
    expect(second[0]).not.toBe(first[0]);
    expect(second[0]!.matchedFields).not.toBe(first[0]!.matchedFields);
    expect(second[0]!.title).not.toBe("caller mutation");
  });

  it("sanitizes to fresh options, ignores top-level extras, and never mutates input", () => {
    const index = createOkfSearch([{
      path: "options.md",
      markdown: concept("type: note\ntags: [kept]", "optionsneedle"),
    }]);
    const where = { types: ["note"], tagsAny: ["kept"] };
    const fields = ["body"] as const;
    const boost = { body: 2 };
    const asOf = new Date("2026-08-24T12:00:00Z");
    const options = {
      where,
      fields,
      boost,
      asOf,
      unknown: "ignored",
    } as OkfSearchOptions & { unknown: string };
    const before = {
      where: { types: [...where.types], tagsAny: [...where.tagsAny] },
      fields: [...fields],
      boost: { ...boost },
      time: asOf.getTime(),
    };

    expect(index.search("optionsneedle", options)).toHaveLength(1);
    expect(where).toEqual(before.where);
    expect(fields).toEqual(before.fields);
    expect(boost).toEqual(before.boost);
    expect(asOf.getTime()).toBe(before.time);
  });

  it("validates known options before blank and zero-limit exits", () => {
    const index = createOkfSearch([]);
    const invalid = { where: { stale: "no" } } as unknown as OkfSearchOptions;

    expect(() => index.search("", invalid)).toThrowError(
      new TypeError("options.where.stale must be a boolean"),
    );
    expect(() => index.search("anything", {
      ...invalid,
      limit: 0,
    })).toThrowError(new TypeError("options.where.stale must be a boolean"));
    expect(() => index.search("", { snippetLength: 0 }))
      .toThrowError(new TypeError(
        "options.snippetLength must be a finite positive integer",
      ));
    expect(index.search("", { limit: 0, unknown: true } as OkfSearchOptions))
      .toEqual([]);
  });

  it("turns synchronous save validation into Promise rejection", async () => {
    const index = createOkfSearch([{
      path: "present.md",
      markdown: concept("type: note", "save-healthy"),
    }]);
    const pending = index.save("");

    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).rejects.toMatchObject({
      name: "OkfError",
      code: "ERR_OKF_FIELD",
      path: "",
      field: "path",
    });
    expect(index.search("save-healthy")).toHaveLength(1);
  });
});
