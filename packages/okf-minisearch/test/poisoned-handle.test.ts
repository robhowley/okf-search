import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import MiniSearch from "minisearch";

import {
  OkfError,
  openOkf,
} from "../src/index.js";
import type { OkfSearch } from "../src/index.js";
import {
  concept,
  createBundle,
  type TestBundle,
} from "./support/bundle.js";

const bundles: TestBundle[] = [];

const failedPath = "nested/guide.md";
const failureMessage =
  `MiniSearch failed while mutating the index for ${failedPath}; ` +
  "this OkfSearch handle is permanently unusable and must be rebuilt";

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    bundles.splice(0).map((bundle) =>
      bundle.cleanup()),
  );
});

async function openedSearch(
  files: Record<string, string> = {},
): Promise<OkfSearch> {
  const tree = await createBundle(files);
  bundles.push(tree);
  return openOkf(tree.root);
}

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }

  throw new Error("Expected operation to throw");
}

function expectPoisonError(
  failure: unknown,
  rawError: Error,
): asserts failure is OkfError {
  expect(failure).toBeInstanceOf(OkfError);
  expect(failure).toMatchObject({
    code: "ERR_OKF_INDEX_UNUSABLE",
    path: failedPath,
    message: failureMessage,
  });
  expect((failure as Error).cause).toBe(rawError);
  expect((failure as OkfError).field).toBeUndefined();
  expect(Object.hasOwn(failure as object, "field")).toBe(false);
}

function expectEveryLaterOperationToRethrow(
  okf: OkfSearch,
  poisonError: OkfError,
): void {
  const calls: [string, () => unknown][] = [
    ["listDegradedDocuments", () => okf.listDegradedDocuments()],
    ["listTypes", () => okf.listTypes()],
    ["indexStats", () => okf.indexStats()],
    ["search", () => okf.search("presentneedle")],
    ["autoSuggest", () => okf.autoSuggest("presentneedle", { limit: -1 })],
    ["malformed ingest", () => okf.ingest({
      path: "malformed.md",
      markdown: "not an OKF document",
    })],
    ["valid ingest", () => okf.ingest({
      path: "valid.md",
      markdown: concept("type: valid", "validneedle"),
    })],
    ["absent remove", () => okf.remove("absent.md")],
    ["present remove", () => okf.remove("present.md")],
  ];

  for (const [name, call] of calls) {
    expect(thrownBy(call), name).toBe(poisonError);
  }
}

describe("poisoned MiniSearch handle", () => {
  it("poisons after a new ingest add fails", async () => {
    const okf = await openedSearch({
      "present.md": concept("type: present", "presentneedle"),
    });
    const rawError = new Error("injected MiniSearch add failure");
    const originalAdd = MiniSearch.prototype.add;
    const addSpy = vi.spyOn(MiniSearch.prototype, "add")
      .mockImplementation(function (this: MiniSearch, document) {
        originalAdd.call(this, document);
        throw rawError;
      });

    const failure = thrownBy(() => okf.ingest({
      path: "./nested//guide.md",
      markdown: concept("type: guide", "guideneedle"),
    }));

    expect(addSpy).toHaveBeenCalledTimes(1);
    expectPoisonError(failure, rawError);

    const discardSpy = vi.spyOn(MiniSearch.prototype, "discard");
    const searchSpy = vi.spyOn(MiniSearch.prototype, "search");
    const autoSuggestSpy = vi.spyOn(MiniSearch.prototype, "autoSuggest");
    expectEveryLaterOperationToRethrow(okf, failure);

    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(discardSpy).not.toHaveBeenCalled();
    expect(searchSpy).not.toHaveBeenCalled();
    expect(autoSuggestSpy).not.toHaveBeenCalled();
  });

  it("poisons after a remove mutation fails", async () => {
    const okf = await openedSearch({
      [failedPath]: concept("type: guide", "guideneedle"),
      "present.md": concept("type: present", "presentneedle"),
    });
    const rawError = new Error("injected MiniSearch discard failure");
    const originalDiscard = MiniSearch.prototype.discard;
    const discardSpy = vi.spyOn(MiniSearch.prototype, "discard")
      .mockImplementation(function (this: MiniSearch, id) {
        originalDiscard.call(this, id);
        throw rawError;
      });

    const failure = thrownBy(() =>
      okf.remove("./nested//guide.md"));

    expect(discardSpy).toHaveBeenCalledTimes(1);
    expectPoisonError(failure, rawError);

    const addSpy = vi.spyOn(MiniSearch.prototype, "add");
    const searchSpy = vi.spyOn(MiniSearch.prototype, "search");
    const autoSuggestSpy = vi.spyOn(MiniSearch.prototype, "autoSuggest");
    expectEveryLaterOperationToRethrow(okf, failure);

    expect(discardSpy).toHaveBeenCalledTimes(1);
    expect(addSpy).not.toHaveBeenCalled();
    expect(searchSpy).not.toHaveBeenCalled();
    expect(autoSuggestSpy).not.toHaveBeenCalled();
  });

  it("poisons after a replacement ingest discard fails", async () => {
    const okf = await openedSearch({
      [failedPath]: concept("type: guide", "guideneedle"),
      "present.md": concept("type: present", "presentneedle"),
    });
    const rawError = new Error("injected MiniSearch replacement discard failure");
    const originalDiscard = MiniSearch.prototype.discard;
    const discardSpy = vi.spyOn(MiniSearch.prototype, "discard")
      .mockImplementation(function (this: MiniSearch, id) {
        originalDiscard.call(this, id);
        throw rawError;
      });

    const failure = thrownBy(() => okf.ingest({
      path: "./nested//guide.md",
      markdown: concept("type: replacement", "replacementneedle"),
    }));

    expect(discardSpy).toHaveBeenCalledTimes(1);
    expectPoisonError(failure, rawError);

    const addSpy = vi.spyOn(MiniSearch.prototype, "add");
    const searchSpy = vi.spyOn(MiniSearch.prototype, "search");
    const autoSuggestSpy = vi.spyOn(MiniSearch.prototype, "autoSuggest");
    expectEveryLaterOperationToRethrow(okf, failure);

    expect(discardSpy).toHaveBeenCalledTimes(1);
    expect(addSpy).not.toHaveBeenCalled();
    expect(searchSpy).not.toHaveBeenCalled();
    expect(autoSuggestSpy).not.toHaveBeenCalled();
  });

  it("keeps prior metadata until a replacement add fails, then poisons", async () => {
    const okf = await openedSearch({
      [failedPath]: concept(
        "type: old/type\nstatus: future",
        "olddegradedneedle",
      ),
      "present.md": concept("type: present", "presentneedle"),
    });
    const rawError = new Error("injected MiniSearch replacement add failure");
    const originalAdd = MiniSearch.prototype.add;
    const discardSpy = vi.spyOn(MiniSearch.prototype, "discard");
    const addSpy = vi.spyOn(MiniSearch.prototype, "add")
      .mockImplementation(function (this: MiniSearch, document) {
        expect(okf.listTypes()).toEqual(["old/type", "present"]);
        expect(okf.listDegradedDocuments()).toEqual([
          expect.objectContaining({
            documentId: "nested/guide",
            path: failedPath,
            diagnostics: [expect.objectContaining({ field: "status" })],
          }),
        ]);
        originalAdd.call(this, document);
        throw rawError;
      });

    const failure = thrownBy(() => okf.ingest({
      path: "./nested//guide.md",
      markdown: concept("type: replacement/type", "replacementneedle"),
    }));

    expect(discardSpy).toHaveBeenCalled();
    expect(addSpy).toHaveBeenCalledTimes(1);
    expectPoisonError(failure, rawError);
    const autoSuggestSpy = vi.spyOn(MiniSearch.prototype, "autoSuggest");
    expectEveryLaterOperationToRethrow(okf, failure);
    expect(autoSuggestSpy).not.toHaveBeenCalled();
  });

  it("poisons when backend ownership diverges before removal", async () => {
    const originalAdd = MiniSearch.prototype.add;
    const originalDiscard = MiniSearch.prototype.discard;
    let backend: MiniSearch | undefined;
    const guideRecordIds: unknown[] = [];
    const addSpy = vi.spyOn(MiniSearch.prototype, "add")
      .mockImplementation(function (this: MiniSearch, document) {
        backend = this;
        const record = document as {
          id: unknown;
          documentId: string;
        };
        if (record.documentId === "nested/guide") {
          guideRecordIds.push(record.id);
        }
        originalAdd.call(this, document);
      });
    const okf = await openedSearch({
      [failedPath]: concept("type: guide", "guideneedle"),
      "present.md": concept("type: present", "presentneedle"),
    });
    addSpy.mockRestore();

    expect(backend).toBeDefined();
    expect(guideRecordIds.length).toBeGreaterThan(0);
    originalDiscard.call(backend!, guideRecordIds[0]);

    const failure = thrownBy(() => okf.remove(failedPath));
    const cause = (failure as Error & { cause?: unknown }).cause;

    expect(cause).toBeInstanceOf(Error);
    expect(cause).toMatchObject({
      message: "OKF index ownership is inconsistent for nested/guide",
    });
    expectPoisonError(failure, cause as Error);
    const autoSuggestSpy = vi.spyOn(MiniSearch.prototype, "autoSuggest");
    expectEveryLaterOperationToRethrow(okf, failure);
    expect(autoSuggestSpy).not.toHaveBeenCalled();
  });

  it("does not poison the handle after parse or field failures", async () => {
    const okf = await openedSearch();

    expect(thrownBy(() => okf.ingest({
      path: "malformed.md",
      markdown: "not an OKF document",
    }))).toMatchObject({
      code: "ERR_OKF_PARSE",
      path: "malformed.md",
    });
    expect(thrownBy(() => okf.ingest({
      path: "../invalid.md",
      markdown: concept("type: invalid"),
    }))).toMatchObject({
      code: "ERR_OKF_FIELD",
      path: "<input>",
      field: "path",
    });
    expect(okf.listTypes()).toEqual([]);

    okf.ingest({
      path: "usable.md",
      markdown: concept("type: usable", "usableneedle"),
    });
    expect(okf.search("usableneedle")).toEqual([
      expect.objectContaining({
        documentId: "usable",
        path: "usable.md",
      }),
    ]);
    expect(okf.listTypes()).toEqual(["usable"]);
    expect(okf.remove("usable.md")).toBe(true);
    expect(okf.search("usableneedle")).toEqual([]);
    expect(okf.listTypes()).toEqual([]);
  });
});
