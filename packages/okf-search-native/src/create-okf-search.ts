import { NativeOkfSearch } from "../native.cjs";

import { OkfError, POISON_MARKER, nativeMessage, throwNativeError } from "./errors.js";
import { sanitizeSearchOptions } from "./search-options.js";

import type {
  IndexStats as NativeIndexStats,
  SearchHit as NativeSearchHit,
} from "../native.cjs";
import type {
  OkfDegradedDocument,
  OkfDiagnostic,
  OkfDocumentInput,
  OkfIndexStats,
  OkfIndexStorageStats,
  OkfLogicalIndexStats,
  OkfIngestResult,
  OkfSearch,
  OkfSearchField,
  OkfSearchHit,
} from "./types.js";

export function createOkfSearch(
  documents: readonly OkfDocumentInput[],
): OkfSearch {
  // Finish caller iteration and getters before translating native failures.
  const inputs = [...documents].map(snapshotInput);
  try {
    return wrapNative(NativeOkfSearch.fromRaw(inputs));
  } catch (error) {
    throwNativeError(error, "<index>");
  }
}

export function wrapNative(native: NativeOkfSearch): OkfSearch {
  let unusableError: OkfError | undefined;

  const assertUsable = (): void => {
    if (unusableError) {
      throw unusableError;
    }
  };

  const callNative = <T>(path: string, call: () => T): T => {
    assertUsable();

    try {
      return call();
    } catch (error) {
      if (nativeMessage(error).match(POISON_MARKER)) {
        const nativePath = error instanceof Error
          ? Object.getOwnPropertyDescriptor(error, "path")?.value
          : undefined;
        const failurePath = typeof nativePath === "string" ? nativePath : path;
        unusableError ??= new OkfError("ERR_OKF_INDEX_UNUSABLE", failurePath);
        throw unusableError;
      }

      throwNativeError(error, path);
    }
  };

  return {
    indexStats(): OkfIndexStats {
      assertUsable();
      return copyIndexStats(callNative("<index>", () => native.indexStats()));
    },

    ingest(input): OkfIngestResult {
      callNative("<index>", () => native.assertUsable());
      const snapshot = snapshotInput(input);
      return callNative("<index>", () => native.ingestRaw(snapshot)) as OkfIngestResult;
    },

    listDegradedDocuments(): readonly OkfDegradedDocument[] {
      assertUsable();
      return callNative("<index>", () => native.listDegradedDocuments())
        .map((document) => ({
          documentId: document.documentId,
          path: document.path,
          diagnostics: copyNonEmptyDiagnostics(document.diagnostics),
        }))
        .sort((left, right) => compare(left.path, right.path));
    },

    listTypes(): readonly string[] {
      assertUsable();
      return [...callNative("<index>", () => native.listTypes())].sort(compare);
    },

    remove(path): boolean {
      assertUsable();

      return callNative("<index>", () => native.removePath(path));
    },

    search(query, options): OkfSearchHit[] {
      assertUsable();
      const nativeOptions = sanitizeSearchOptions(options);

      if (!query.trim() || nativeOptions.limit === 0) {
        return [];
      }

      return callNative("<index>", () => native.search(query.trim(), nativeOptions))
        .map(copySearchHit);
    },

    autoSuggest(_query, _options): never {
      assertUsable();
      throw new OkfError("ERR_OKF_UNSUPPORTED", "autoSuggest");
    },
  };
}

function snapshotInput(input: OkfDocumentInput): OkfDocumentInput {
  return { path: input.path, markdown: input.markdown };
}

function copyDiagnostics(
  diagnostics: readonly {
    readonly code: string;
    readonly path: string;
    readonly field?: string;
    readonly message: string;
  }[],
): OkfDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    code: diagnostic.code as OkfDiagnostic["code"],
    path: diagnostic.path,
    ...(diagnostic.field === undefined ? {} : { field: diagnostic.field }),
    message: diagnostic.message,
  }));
}

function copyNonEmptyDiagnostics(
  diagnostics: Parameters<typeof copyDiagnostics>[0],
): OkfDegradedDocument["diagnostics"] {
  const [first, ...rest] = copyDiagnostics(diagnostics);
  if (!first) {
    throw new Error("Degraded native documents must contain a diagnostic");
  }
  return [first, ...rest];
}

function copyIndexStats(stats: NativeIndexStats): OkfIndexStats {
  const types = Object.freeze(
    stats.logical.types
      .map(({ type, documentCount }) =>
        Object.freeze({ type, documentCount }))
      .sort((left, right) => compare(left.type, right.type)),
  );
  const logical: OkfLogicalIndexStats = Object.freeze({
    documents: Object.freeze({
      total: stats.logical.documents.total,
      strict: stats.logical.documents.strict,
      degraded: stats.logical.documents.degraded,
    }),
    types,
    statuses: Object.freeze({
      draft: stats.logical.statuses.draft,
      stable: stats.logical.statuses.stable,
      deprecated: stats.logical.statuses.deprecated,
      unclassified: stats.logical.statuses.unclassified,
    }),
    trustTiers: Object.freeze({
      unverified: stats.logical.trustTiers.unverified,
      machineConfirmed: stats.logical.trustTiers.machineConfirmed,
      humanReviewed: stats.logical.trustTiers.humanReviewed,
      unclassified: stats.logical.trustTiers.unclassified,
    }),
  });
  const storage: OkfIndexStorageStats = Object.freeze({
    kind: "in-memory-index-files" as const,
    sizeInBytes: stats.storage.sizeInBytes,
  });

  return Object.freeze({ logical, storage });
}

function copySearchHit(hit: NativeSearchHit): OkfSearchHit {
  return {
    documentId: hit.documentId,
    title: hit.title,
    sectionId: hit.sectionId,
    score: hit.score,
    conformance: hit.conformance as OkfSearchHit["conformance"],
    matchedFields: [...hit.matchedFields] as OkfSearchField[],
    headingPath: hit.headingPath,
    path: hit.path,
    startLine: hit.startLine,
    endLine: hit.endLine,
    snippet: hit.snippet,
  };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
