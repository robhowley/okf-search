import MiniSearch from "minisearch";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { OkfIndexStats } from "../src/index.js";

import {
  createOkfSearch,
} from "../src/index.js";
import {
  concept,
} from "./support/bundle.js";

const EMPTY_LOGICAL_STATS = {
  documents: {
    total: 0,
    strict: 0,
    degraded: 0,
  },
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
} as const;

const SERIALIZED_STORAGE = {
  kind: "serialized-index",
  format: "minisearch-json-utf8",
  sizeInBytes: expect.any(Number),
};

const EMPTY_STATS = {
  logical: EMPTY_LOGICAL_STATS,
  storage: SERIALIZED_STORAGE,
};

function expectSerializedStorage(stats: OkfIndexStats): void {
  expect(stats.storage).toEqual({
    kind: "serialized-index",
    format: "minisearch-json-utf8",
    sizeInBytes: expect.any(Number),
  });
  if (stats.storage.kind === "serialized-index") {
    expect(Number.isSafeInteger(stats.storage.sizeInBytes)).toBe(true);
    expect(stats.storage.sizeInBytes).toBeGreaterThan(0);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("indexStats", () => {
  it("returns the empty logical snapshot with serialized MiniSearch storage", () => {
    const okf = createOkfSearch([]);
    const stats = okf.indexStats();

    expect(stats).toEqual(EMPTY_STATS);
    expectSerializedStorage(stats);
    expect(Object.keys(stats)).toEqual(["logical", "storage"]);
    expect(Object.keys(stats.storage)).toEqual([
      "kind",
      "format",
      "sizeInBytes",
    ]);
  });

  it("counts each logical document once across all bucket families", () => {
    const okf = createOkfSearch([
      {
        path: "draft.md",
        markdown: concept(
          "type: guide\nstatus: draft",
          "# First\ndraft body\n\n# Second\nsecond draft body",
        ),
      },
      {
        path: "stable.md",
        markdown: concept(`
          type: runbook
          status: stable
          verified:
            by: process:builder
            at: 2026-08-24T10:00:00Z
        `, "stable body"),
      },
      {
        path: "deprecated.md",
        markdown: concept(`
          type: playbook
          status: deprecated
          verified:
            - by: process:builder
              at: 2026-08-24T10:00:00Z
            - by: human:alice
              at: 2026-08-24T11:00:00Z
        `, "deprecated body"),
      },
      {
        path: "degraded.md",
        markdown: concept(
          "type: guide\nstatus: future\nverified: broken",
          "degraded body",
        ),
      },
    ]);

    const stats = okf.indexStats();
    expect(stats).toEqual({
      logical: {
        documents: {
          total: 4,
          strict: 3,
          degraded: 1,
        },
        types: [
          { type: "guide", documentCount: 2 },
          { type: "playbook", documentCount: 1 },
          { type: "runbook", documentCount: 1 },
        ],
        statuses: {
          draft: 1,
          stable: 1,
          deprecated: 1,
          unclassified: 1,
        },
        trustTiers: {
          unverified: 1,
          machineConfirmed: 1,
          humanReviewed: 1,
          unclassified: 1,
        },
      },
      storage: SERIALIZED_STORAGE,
    });
    expectSerializedStorage(stats);
  });

  it("returns recursively frozen snapshots that stay detached across mutations", () => {
    const okf = createOkfSearch([
      {
        path: "before.md",
        markdown: concept("type: before", "before body"),
      },
    ]);
    const prior = okf.indexStats();
    expectSerializedStorage(prior);

    expect(okf.indexStats()).toBe(prior);
    for (const value of [
      prior,
      prior.logical,
      prior.logical.documents,
      prior.logical.types,
      prior.logical.types[0],
      prior.logical.statuses,
      prior.logical.trustTiers,
      prior.storage,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }

    expect(() => {
      (prior.logical.types as Array<{ type: string; documentCount: number }>).push({
        type: "caller",
        documentCount: 1,
      });
    }).toThrow(TypeError);
    expect(() => {
      (prior.logical.types[0] as { type: string }).type = "caller";
    }).toThrow(TypeError);
    expect(() => {
      (prior.logical.statuses as { stable: number }).stable = 99;
    }).toThrow(TypeError);
    expect(() => {
      (prior.storage as {
        kind: string;
        format: string;
        sizeInBytes: number;
      }).format = "caller";
    }).toThrow(TypeError);

    okf.ingest({
      path: "after.md",
      markdown: concept("type: after", "after body"),
    });

    expect(prior).toEqual({
      ...EMPTY_STATS,
      logical: {
        ...EMPTY_STATS.logical,
        documents: {
          total: 1,
          strict: 1,
          degraded: 0,
        },
        types: [{ type: "before", documentCount: 1 }],
        statuses: {
          draft: 0,
          stable: 1,
          deprecated: 0,
          unclassified: 0,
        },
        trustTiers: {
          unverified: 1,
          machineConfirmed: 0,
          humanReviewed: 0,
          unclassified: 0,
        },
      },
    });
    const current = okf.indexStats();
    expect(current).toEqual({
      ...EMPTY_STATS,
      logical: {
        ...EMPTY_STATS.logical,
        documents: {
          total: 2,
          strict: 2,
          degraded: 0,
        },
        types: [
          { type: "after", documentCount: 1 },
          { type: "before", documentCount: 1 },
        ],
        statuses: {
          draft: 0,
          stable: 2,
          deprecated: 0,
          unclassified: 0,
        },
        trustTiers: {
          unverified: 2,
          machineConfirmed: 0,
          humanReviewed: 0,
          unclassified: 0,
        },
      },
    });
    expectSerializedStorage(current);
  });

  it("lazily caches bytes and invalidates them after successful mutations", () => {
    const toJSON = vi.spyOn(MiniSearch.prototype, "toJSON");
    const okf = createOkfSearch([{
      path: "unicode.md",
      markdown: concept("type: note\ntitle: café 🧭", "body"),
    }]);

    expect(toJSON).not.toHaveBeenCalled();
    const initial = okf.indexStats();
    expect(toJSON).toHaveBeenCalledTimes(1);
    if (toJSON.mock.results[0]?.type !== "return") {
      throw new Error("MiniSearch serialization did not return a value");
    }
    const serialized = JSON.stringify(toJSON.mock.results[0].value);
    if (serialized === undefined) {
      throw new Error("MiniSearch serialization returned undefined");
    }
    expect(initial.storage).toMatchObject({
      kind: "serialized-index",
      format: "minisearch-json-utf8",
      sizeInBytes: new TextEncoder().encode(serialized).byteLength,
    });
    if (initial.storage.kind === "serialized-index") {
      expect(initial.storage.sizeInBytes).toBeGreaterThan(
        serialized.length,
      );
    }
    expect(okf.indexStats()).toBe(initial);
    expect(toJSON).toHaveBeenCalledTimes(1);

    expect(() => okf.ingest({
      path: "failed.md",
      markdown: concept("type: [", "failed body"),
    })).toThrow(expect.objectContaining({ code: "ERR_OKF_PARSE" }));
    expect(okf.indexStats()).toBe(initial);
    expect(toJSON).toHaveBeenCalledTimes(1);

    okf.ingest({
      path: "added.md",
      markdown: concept("type: guide", "added body"),
    });
    expect(toJSON).toHaveBeenCalledTimes(1);
    const added = okf.indexStats();
    expect(added).not.toBe(initial);
    expect(toJSON).toHaveBeenCalledTimes(2);

    expect(okf.remove("added.md")).toBe(true);
    expect(toJSON).toHaveBeenCalledTimes(2);
    const removed = okf.indexStats();
    expect(removed).not.toBe(added);
    expect(toJSON).toHaveBeenCalledTimes(3);
  });

  it("updates only after successful replacement or removal", () => {
    const okf = createOkfSearch([
      {
        path: "state.md",
        markdown: concept("type: original", "original body"),
      },
    ]);
    const initial = okf.indexStats();

    expect(() => okf.ingest({
      path: "./state.md",
      markdown: concept("type: [", "failed body"),
    })).toThrow(expect.objectContaining({
      code: "ERR_OKF_PARSE",
      path: "state.md",
    }));
    expect(okf.indexStats()).toBe(initial);

    okf.ingest({
      path: "./state.md",
      markdown: concept(
        "type: replacement\nstatus: deprecated\nverified: broken",
        "replacement body",
      ),
    });
    const replaced = okf.indexStats();
    expect(replaced).toEqual({
      ...EMPTY_STATS,
      logical: {
        ...EMPTY_STATS.logical,
        documents: {
          total: 1,
          strict: 0,
          degraded: 1,
        },
        types: [{ type: "replacement", documentCount: 1 }],
        statuses: {
          draft: 0,
          stable: 0,
          deprecated: 1,
          unclassified: 0,
        },
        trustTiers: {
          unverified: 0,
          machineConfirmed: 0,
          humanReviewed: 0,
          unclassified: 1,
        },
      },
    });
    expectSerializedStorage(replaced);

    expect(okf.remove("./state.md")).toBe(true);
    const empty = okf.indexStats();
    expect(empty).toEqual(EMPTY_STATS);
    expectSerializedStorage(empty);
    expect(okf.remove("state.md")).toBe(false);
    expect(okf.indexStats()).toBe(empty);
  });
});
