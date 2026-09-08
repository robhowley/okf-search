import {
  describe,
  expect,
  it,
} from "vitest";

import {
  createOkfSearch,
} from "../src/index.js";
import {
  concept,
} from "./support/bundle.js";

const EMPTY_STATS = {
  logical: {
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
  },
  storage: {
    kind: "unavailable",
  },
} as const;

describe("indexStats", () => {
  it("returns the empty logical snapshot with unavailable MiniSearch storage", () => {
    const okf = createOkfSearch([]);

    expect(okf.indexStats()).toEqual(EMPTY_STATS);
    expect(Object.keys(okf.indexStats())).toEqual(["logical", "storage"]);
    expect(Object.keys(okf.indexStats().storage)).toEqual(["kind"]);
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

    expect(okf.indexStats()).toEqual({
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
      storage: {
        kind: "unavailable",
      },
    });
  });

  it("returns recursively frozen snapshots that stay detached across mutations", () => {
    const okf = createOkfSearch([
      {
        path: "before.md",
        markdown: concept("type: before", "before body"),
      },
    ]);
    const prior = okf.indexStats();

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
      (prior.storage as { kind: string }).kind = "caller";
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
    expect(okf.indexStats()).toEqual({
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

    expect(okf.remove("./state.md")).toBe(true);
    expect(okf.indexStats()).toEqual(EMPTY_STATS);
    expect(okf.remove("state.md")).toBe(false);
    expect(okf.indexStats()).not.toBe(replaced);
  });
});
