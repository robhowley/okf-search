import {
  PrepareError,
  normalizeOkfDocumentIdentity,
  prepareOkfDocument,
  prepareOkfDocuments,
} from "@okf-internal/prepare";
import { NativeOkfSearch } from "../native.cjs";

import { OkfError } from "./errors.js";
import { mapPreparedDocument, mapPreparedDocuments } from "./prepared-to-native.js";
import { sanitizeSearchOptions } from "./search-options.js";

import type {
  PreparedOkfDocument,
} from "@okf-internal/prepare";
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

const POISON_MARKER = /^\[ERR_OKF_INDEX_UNUSABLE\](?: |$)/;
const NATIVE_MARKER = /^\[ERR_OKF_[A-Z_]+\](?: |$)/;
const INVALID_SEARCH_OPTIONS_MARKER =
  /^\[ERR_OKF_INVALID_SEARCH_OPTIONS\](?: |$)/;

export function createOkfSearch(
  documents: readonly OkfDocumentInput[],
): OkfSearch {
  let prepared: readonly PreparedOkfDocument[];

  try {
    prepared = prepareOkfDocuments(documents);
  } catch (error) {
    throwPreparationError(error);
  }

  let native: NativeOkfSearch;

  try {
    native = NativeOkfSearch.fromPrepared(mapPreparedDocuments(prepared));
  } catch (error) {
    throwNativeError(error, "<index>");
  }

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
        unusableError ??= new OkfError("ERR_OKF_INDEX_UNUSABLE", path);
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
      assertUsable();

      let result: PreparedOkfDocument;
      try {
        result = prepareOkfDocument(input);
      } catch (error) {
        throwPreparationError(error);
      }

      callNative(result.identity.path, () => {
        native.ingestPrepared(mapPreparedDocument(result));
      });

      if (result.conformance === "strict") {
        return {
          conformance: "strict",
          document: result.document,
        };
      }

      return {
        conformance: "degraded",
        documentId: result.identity.documentId,
        path: result.identity.path,
        diagnostics: copyNonEmptyDiagnostics(result.diagnostics),
      };
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

      let identity;
      try {
        identity = normalizeOkfDocumentIdentity(path);
      } catch (error) {
        throwPreparationError(error);
      }

      return callNative(
        identity.path,
        () => native.removeDocument(identity.documentId),
      );
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

function throwPreparationError(error: unknown): never {
  if (error instanceof PrepareError) {
    throw new OkfError(error.code, error.path, {
      ...(error.field === undefined ? {} : { field: error.field }),
      ...(error.cause === undefined ? {} : { cause: error.cause }),
    });
  }

  throw error;
}

function throwNativeError(error: unknown, path: string): never {
  const message = nativeMessage(error);

  if (POISON_MARKER.test(message)) {
    throw new OkfError("ERR_OKF_INDEX_UNUSABLE", path);
  }

  const sanitized = message.replace(NATIVE_MARKER, "").trim();
  throw INVALID_SEARCH_OPTIONS_MARKER.test(message)
    ? new TypeError(sanitized)
    : new Error(sanitized || "Native OKF search failed");
}

function nativeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
