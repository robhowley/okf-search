import {
  afterEach,
  describe,
  expect,
  expectTypeOf,
  it,
} from "vitest";

import * as api from "../src/index.js";
import type {
  IsoDateTime,
  OkfAttester,
  OkfAutoSuggestOptions,
  OkfConformance,
  OkfDiagnostic,
  OkfDiagnosticCode,
  OkfDegradedDocument,
  OkfDocument,
  OkfDocumentInput,
  OkfErrorCode,
  OkfExecutor,
  OkfGeneration,
  OkfIndexStats,
  OkfIngestResult,
  OkfParameter,
  OkfSearch,
  OkfSearchField,
  OkfSearchHit,
  OkfSearchOptions,
  OkfSource,
  OkfSuggestion,
  OkfStatus,
  OkfTimeWindow,
  OkfTrustTier,
  OkfValidationResult,
  OkfVerification,
} from "../src/index.js";
import {
  concept,
  createBundle,
  type TestBundle,
} from "./support/bundle.js";

const bundles: TestBundle[] = [];

afterEach(async () => {
  await Promise.all(
    bundles.splice(0).map((bundle) =>
      bundle.cleanup()),
  );
});

describe("package API", () => {
  it("exports the runtime boundary", () => {
    expect(Object.keys(api).sort()).toEqual([
      "OkfError",
      "createOkfSearch",
      "openOkf",
      "validateOkfDocument",
    ]);
  });

  it("opens, ingests, and searches through the package root", async () => {
    const tree = await createBundle({});
    bundles.push(tree);

    expect(api.OkfError).toBeTypeOf("function");
    expect(api.validateOkfDocument({
      path: "package-api.md",
      markdown: concept("type: note"),
    })).toEqual({
      isValid: true,
      isIndexable: true,
      errors: [],
    });

    const direct = api.createOkfSearch([{
      path: "direct.md",
      markdown: concept("type: direct", "directpackageneedle"),
    }]);
    expect(direct).not.toBeInstanceOf(Promise);
    expect(direct.search("directpackageneedle")).toHaveLength(1);

    const okf = await api.openOkf(tree.root);

    expect(okf.ingest).toBeTypeOf("function");
    expect(okf.listDegradedDocuments).toBeTypeOf("function");
    expect(okf.listTypes).toBeTypeOf("function");
    expect(okf.indexStats).toBeTypeOf("function");
    expect(okf.remove).toBeTypeOf("function");
    expect(okf.search).toBeTypeOf("function");
    expect(okf.autoSuggest).toBeTypeOf("function");
    expect(okf.listTypes()).toEqual([]);

    const result = okf.ingest({
      path: "package-api.md",
      markdown: concept(
        "type: note",
        "packageboundaryneedle",
      ),
    });
    const hits = okf.search("packageboundaryneedle");
    const suggestions = okf.autoSuggest("packageboundaryneed");

    if (result.conformance !== "strict") {
      expect.unreachable("valid input must return the strict arm");
    }
    expect(result.document.id).toBe("package-api");
    expect(result.document.status).toBe("stable");
    expect(okf.listTypes()).toEqual(["note"]);
    expect(okf.indexStats().logical.documents).toEqual({
      total: 1,
      strict: 1,
      degraded: 0,
    });
    expect(Object.keys(result)).toEqual(["conformance", "document"]);
    expect(Object.hasOwn(result, "records")).toBe(false);
    expect(Object.hasOwn(result, "diagnostics")).toBe(false);
    expect(hits).toEqual([
      expect.objectContaining({
        documentId: "package-api",
        path: "package-api.md",
        conformance: "strict",
      }),
    ]);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]).toEqual({
      suggestion: expect.any(String),
      terms: expect.any(Array),
      score: expect.any(Number),
    });
    expect(Object.keys(suggestions[0]!)).toEqual([
      "suggestion",
      "terms",
      "score",
    ]);
    expect(suggestions[0]!.terms).toEqual(
      suggestions[0]!.suggestion.split(" "),
    );
    expect(Number.isFinite(suggestions[0]!.score)).toBe(true);
    expectTypeOf(result).toMatchTypeOf<OkfIngestResult>();
    expectTypeOf(hits).toEqualTypeOf<OkfSearchHit[]>();
    expectTypeOf(suggestions).toEqualTypeOf<OkfSuggestion[]>();
    expectTypeOf<OkfAutoSuggestOptions>().toEqualTypeOf<OkfSearchOptions>();

    const degradedInput = {
      path: "degraded-package-api.md",
      markdown: concept(
        "type: degraded-note\ntitle: 1",
        "packageboundarydegradedneedle",
      ),
    };
    const degradedValidation = api.validateOkfDocument(degradedInput);
    expect(degradedValidation).toMatchObject({
      isValid: false,
      isIndexable: true,
      errors: [expect.objectContaining({ field: "title" })],
    });
    const degraded = okf.ingest(degradedInput);
    expect(Object.keys(degraded)).toEqual([
      "conformance",
      "documentId",
      "path",
      "diagnostics",
    ]);
    expect(Object.hasOwn(degraded, "document")).toBe(false);
    if (degraded.conformance !== "degraded") {
      expect.unreachable("malformed optional metadata must return the degraded arm");
    }
    expect(degraded).toMatchObject({
      documentId: "degraded-package-api",
      path: "degraded-package-api.md",
    });
    expect(okf.search("packageboundarydegradedneedle", {
      where: { conformance: ["degraded"] as const },
    })).toEqual([
      expect.objectContaining({
        documentId: "degraded-package-api",
        conformance: "degraded",
      }),
    ]);
    const inventory = okf.listDegradedDocuments();
    expect(inventory).toEqual([
      expect.objectContaining({
        documentId: "degraded-package-api",
        path: "degraded-package-api.md",
        diagnostics: degraded.diagnostics,
      }),
    ]);
    expect(inventory[0]!.diagnostics).not.toBe(degraded.diagnostics);
    expect(inventory[0]!.diagnostics[0]).not.toBe(degraded.diagnostics[0]);
    degraded.diagnostics[0]!.message = "caller mutation";
    Array.prototype.push.call(degraded.diagnostics, {
      code: "ERR_OKF_FIELD",
      path: "caller.md",
      message: "caller mutation",
    });
    expect(okf.listDegradedDocuments()).toEqual(inventory);

    const fatalInput = {
      path: "fatal-package-api.md",
      markdown: concept("type: ' '", "packageboundaryfatalneedle"),
    };
    expect(api.validateOkfDocument(fatalInput)).toMatchObject({
      isValid: false,
      isIndexable: false,
      errors: [expect.objectContaining({
        code: "ERR_OKF_FIELD",
        field: "type",
      })],
    });
    expect(() => okf.ingest(fatalInput)).toThrow(expect.objectContaining({
      code: "ERR_OKF_FIELD",
      field: "type",
    }));
    expect(okf.search("packageboundaryfatalneedle")).toEqual([]);

    expect(okf.remove("./degraded-package-api.md")).toBe(true);
    expect(okf.listDegradedDocuments()).toEqual([]);
    expect(okf.remove("degraded-package-api.md")).toBe(false);
  });

  it("exports OkfError with its supported error code", () => {
    const error = new api.OkfError(
      "ERR_OKF_FIELD",
      "package-api.md",
      { field: "path" },
    );
    const code: OkfErrorCode = error.code;

    expect(error).toBeInstanceOf(api.OkfError);
    expect(error).toMatchObject({
      code,
      path: "package-api.md",
      field: "path",
    });
  });

  it("keeps supported public and transitive types importable", () => {
    const isoDateTime: IsoDateTime =
      "2026-08-24T10:00:00Z";
    const status = "stable" as OkfStatus;
    const timeWindow: OkfTimeWindow = {
      from: isoDateTime,
      to: isoDateTime,
    };
    const source: OkfSource = {
      resource: "source.md",
      usageWindow: timeWindow,
    };
    const generation: OkfGeneration = {
      by: "process:builder",
      at: isoDateTime,
    };
    const verification: OkfVerification = {
      by: "human:reviewer",
      at: isoDateTime,
    };
    const parameter: OkfParameter = {
      name: "input",
      type: "string",
      required: true,
    };
    const executor: OkfExecutor = {
      resource: "executor",
      receipt: ["receipt"],
    };
    const attester: OkfAttester = {
      resource: "attester",
    };
    const document: OkfDocument = {
      id: "package-api",
      type: "note",
      title: "Package API",
      tags: ["public"],
      sources: [source],
      usageWindow: timeWindow,
      generated: generation,
      verified: [verification],
      status,
      staleAfter: isoDateTime,
      runtime: "node",
      parameters: [parameter],
      computation: "test",
      executor,
      attester,
      body: "body",
      extensions: {},
    };
    const diagnosticCode: OkfDiagnosticCode = "ERR_OKF_FIELD";
    const diagnostic: OkfDiagnostic = {
      code: diagnosticCode,
      path: "package-api.md",
      field: "status",
      message: "diagnostic",
    };
    const validationResult: OkfValidationResult = {
      isValid: false,
      isIndexable: true,
      errors: [diagnostic],
    } as OkfValidationResult;

    expectTypeOf(isoDateTime).toEqualTypeOf<IsoDateTime>();
    expectTypeOf<OkfStatus>().toEqualTypeOf<
      "draft" | "stable" | "deprecated"
    >();
    expectTypeOf<OkfTrustTier>().toEqualTypeOf<
      "unverified" | "machine-confirmed" | "human-reviewed"
    >();
    expectTypeOf(timeWindow).toEqualTypeOf<OkfTimeWindow>();
    expectTypeOf(source).toEqualTypeOf<OkfSource>();
    expectTypeOf(generation).toEqualTypeOf<OkfGeneration>();
    expectTypeOf(verification).toEqualTypeOf<OkfVerification>();
    expectTypeOf(parameter).toEqualTypeOf<OkfParameter>();
    expectTypeOf(executor).toEqualTypeOf<OkfExecutor>();
    expectTypeOf(attester).toEqualTypeOf<OkfAttester>();
    expectTypeOf(document).toEqualTypeOf<OkfDocument>();
    expectTypeOf<OkfDocument["status"]>().toEqualTypeOf<OkfStatus>();
    expectTypeOf<OkfDegradedDocument>().toEqualTypeOf<{
      readonly documentId: string;
      readonly path: string;
      readonly diagnostics: readonly [
        OkfDiagnostic,
        ...OkfDiagnostic[],
      ];
    }>();
    expectTypeOf<OkfIngestResult>().toEqualTypeOf<
      | {
          readonly conformance: "strict";
          readonly document: OkfDocument;
        }
      | ({ readonly conformance: "degraded" } & OkfDegradedDocument)
    >();
    expectTypeOf<OkfErrorCode>().toEqualTypeOf<
      | "ERR_OKF_READ"
      | "ERR_OKF_PARSE"
      | "ERR_OKF_FIELD"
      | "ERR_OKF_INDEX_UNUSABLE"
    >();
    expectTypeOf<OkfDiagnosticCode>().toEqualTypeOf<
      "ERR_OKF_PARSE" | "ERR_OKF_FIELD"
    >();
    expectTypeOf(diagnostic).toEqualTypeOf<OkfDiagnostic>();
    expectTypeOf(validationResult).toEqualTypeOf<OkfValidationResult>();
  });

  it("exports the exact search controls contract", () => {
    const fields = ["heading", "body"] as const;
    const boost = { title: 1.5, body: 2 } as const;
    const conformance = ["strict", "degraded"] as const;
    const options: OkfSearchOptions = {
      match: "all",
      fields,
      fuzzy: true,
      boost,
      where: { conformance },
    };

    expectTypeOf<OkfSearchField>().toEqualTypeOf<
      | "resource"
      | "title"
      | "heading"
      | "description"
      | "tags"
      | "type"
      | "sources"
      | "body"
    >();
    expectTypeOf<OkfSearchOptions["fields"]>()
      .toEqualTypeOf<
        readonly OkfSearchField[] | undefined
      >();
    expectTypeOf<OkfSearchOptions["fuzzy"]>()
      .toEqualTypeOf<boolean | number | undefined>();
    expectTypeOf<OkfSearchOptions["boost"]>()
      .toEqualTypeOf<Readonly<Partial<Record<OkfSearchField, number>>> | undefined>();
    expectTypeOf<OkfConformance>().toEqualTypeOf<
      "strict" | "degraded"
    >();
    expectTypeOf<NonNullable<OkfSearchOptions["where"]>["conformance"]>()
      .toEqualTypeOf<readonly OkfConformance[] | undefined>();
    expectTypeOf<OkfSearchHit["conformance"]>()
      .toEqualTypeOf<OkfConformance>();
    expectTypeOf<OkfSearchHit["matchedFields"]>()
      .toEqualTypeOf<OkfSearchField[]>();
    expectTypeOf<OkfSearchHit["title"]>()
      .toEqualTypeOf<string>();
    expect(options).toMatchObject({
      match: "all",
      fields,
      fuzzy: true,
      boost,
      where: { conformance },
    });
  });

  it("keeps generated-declaration source types usable", () => {
    expectTypeOf(api.validateOkfDocument)
      .parameter(0)
      .toEqualTypeOf<OkfDocumentInput>();
    expectTypeOf(api.validateOkfDocument)
      .returns
      .toEqualTypeOf<OkfValidationResult>();
    expectTypeOf(api.createOkfSearch)
      .toEqualTypeOf<(
        documents: readonly OkfDocumentInput[],
      ) => OkfSearch>();
    expectTypeOf(api.openOkf)
      .toEqualTypeOf<(root: string) => Promise<OkfSearch>>();
    expectTypeOf<OkfSearch["ingest"]>()
      .parameter(0)
      .toEqualTypeOf<OkfDocumentInput>();
    expectTypeOf<OkfSearch["ingest"]>()
      .returns
      .toEqualTypeOf<OkfIngestResult>();
    expectTypeOf<OkfSearch["listDegradedDocuments"]>()
      .toEqualTypeOf<() => readonly OkfDegradedDocument[]>();
    expectTypeOf<OkfSearch["listTypes"]>()
      .toEqualTypeOf<() => readonly string[]>();
    expectTypeOf<OkfSearch["indexStats"]>()
      .toEqualTypeOf<() => OkfIndexStats>();
    expectTypeOf<OkfSearch["remove"]>()
      .toEqualTypeOf<(path: string) => boolean>();
    expectTypeOf<OkfSearch["search"]>()
      .parameter(1)
      .toEqualTypeOf<OkfSearchOptions | undefined>();
    expectTypeOf<OkfSearch["search"]>()
      .returns
      .toEqualTypeOf<OkfSearchHit[]>();
  });
});
