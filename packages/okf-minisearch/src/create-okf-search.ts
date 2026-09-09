import MiniSearch from "minisearch";

import { autoSuggest } from "./auto-suggest.js";
import { OkfError } from "./errors.js";
import {
  normalizeDocumentIdentity,
  prepareDocument,
} from "./ingest.js";
import { search } from "./search.js";

import type {
  OkfDegradedDocument,
  OkfDiagnostic,
  OkfDocumentInput,
  OkfIndexStats,
  OkfIngestResult,
  OkfLogicalIndexStats,
  OkfSearch,
  OkfStatus,
  OkfTrustTier,
} from "./types.js";
import type {
  NonEmptyDiagnostics,
  NonEmptyRecordIds,
  OkfIndexRecord,
  OkfPreparedDocument,
} from "./internal-types.js";

type IndexedDocumentState =
  | {
      readonly path: string;
      readonly type: string;
      readonly recordIds: NonEmptyRecordIds;
      readonly conformance: "strict";
      readonly status: OkfStatus;
      readonly trustTier: OkfTrustTier;
    }
  | {
      readonly path: string;
      readonly type: string;
      readonly recordIds: NonEmptyRecordIds;
      readonly conformance: "degraded";
      readonly status?: OkfStatus;
      readonly trustTier?: OkfTrustTier;
      readonly diagnostics: NonEmptyDiagnostics;
    };

interface MutableLogicalIndexStats {
  total: number;
  strict: number;
  degraded: number;
  types: Map<string, number>;
  statuses: Record<keyof OkfLogicalIndexStats["statuses"], number>;
  trustTiers: Record<keyof OkfLogicalIndexStats["trustTiers"], number>;
}

interface NormalizedDocumentInput {
  readonly path: string;
  readonly markdown: string;
  readonly documentId: string;
}

export function createOkfSearch(
  documents: readonly OkfDocumentInput[],
): OkfSearch {
  const normalized = Array.from(documents, (input): NormalizedDocumentInput => {
    const identity = normalizeDocumentIdentity(input.path);
    return {
      path: identity.path,
      markdown: input.markdown,
      documentId: identity.documentId,
    };
  }).sort((left, right) => comparePaths(left.path, right.path));

  const documentIds = new Set<string>();
  for (const input of normalized) {
    if (documentIds.has(input.documentId)) {
      throw new OkfError("ERR_OKF_FIELD", input.path, { field: "path" });
    }
    documentIds.add(input.documentId);
  }

  const prepared = normalized.map((input) =>
    prepareDocument({
      path: input.path,
      markdown: input.markdown,
    }));

  const index = createIndex();
  addRecords(index, prepared.flatMap(
    (result) => [...result.projection.records],
  ));

  const documentsById = new Map<string, IndexedDocumentState>();
  const logicalStats: MutableLogicalIndexStats = {
    total: 0,
    strict: 0,
    degraded: 0,
    types: new Map(),
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
  };
  let typeSnapshot = createTypeSnapshot(logicalStats.types);
  let statsSnapshot: OkfIndexStats | undefined;
  let unusableError: OkfError | undefined;

  const assertUsable = (): void => {
    if (unusableError) throw unusableError;
  };

  const poison = (path: string, cause: unknown): never => {
    const error = new OkfError(
      "ERR_OKF_INDEX_UNUSABLE",
      path,
      { cause },
    );
    unusableError = error;
    throw error;
  };

  const commitDocumentState = (
    documentId: string,
    next: IndexedDocumentState | undefined,
  ): void => {
    const previous = documentsById.get(documentId);
    let typesChanged = false;

    if (previous) {
      typesChanged = applyLogicalStats(logicalStats, previous, -1);
    }
    if (next) {
      typesChanged = applyLogicalStats(logicalStats, next, 1) || typesChanged;
    }

    if (next) documentsById.set(documentId, next);
    else documentsById.delete(documentId);

    if (typesChanged) {
      typeSnapshot = createTypeSnapshot(logicalStats.types);
    }
    statsSnapshot = undefined;
  };

  for (const result of prepared) {
    commitDocumentState(
      result.projection.documentId,
      indexedState(result),
    );
  }

  return {
    ingest(input): OkfIngestResult {
      assertUsable();
      const result = prepareDocument(input);
      const { projection } = result;
      const previous = documentsById.get(projection.documentId);

      if (previous) {
        try {
          assertOwnedRecordIds(index, projection.documentId, previous.recordIds);
        } catch (cause) {
          poison(projection.path, cause);
        }

        try {
          index.discardAll(previous.recordIds);
        } catch (cause) {
          poison(projection.path, cause);
        }
      }

      try {
        index.addAll(cloneRecords(projection.records));
      } catch (cause) {
        poison(projection.path, cause);
      }

      commitDocumentState(projection.documentId, indexedState(result));

      if (result.conformance === "strict") {
        return {
          conformance: "strict",
          document: result.document,
        };
      }

      return {
        conformance: "degraded",
        documentId: projection.documentId,
        path: projection.path,
        diagnostics: copyNonEmptyDiagnostics(result.diagnostics),
      };
    },

    listDegradedDocuments(): readonly OkfDegradedDocument[] {
      assertUsable();
      return [...documentsById.entries()]
        .filter((entry): entry is [string, Extract<IndexedDocumentState, {
          readonly conformance: "degraded";
        }>] => entry[1].conformance === "degraded")
        .sort((left, right) => comparePaths(left[1].path, right[1].path))
        .map(([documentId, state]) => ({
          documentId,
          path: state.path,
          diagnostics: copyNonEmptyDiagnostics(state.diagnostics),
        }));
    },

    listTypes() {
      assertUsable();
      return typeSnapshot;
    },

    indexStats() {
      assertUsable();
      return statsSnapshot ??= createIndexStatsSnapshot(logicalStats, index);
    },

    remove(path) {
      assertUsable();
      const identity = normalizeDocumentIdentity(path);
      const state = documentsById.get(identity.documentId);
      if (!state) return false;

      try {
        assertOwnedRecordIds(index, identity.documentId, state.recordIds);
      } catch (cause) {
        poison(identity.path, cause);
      }

      try {
        index.discardAll(state.recordIds);
      } catch (cause) {
        poison(identity.path, cause);
      }
      commitDocumentState(identity.documentId, undefined);
      return true;
    },

    search(query, options) {
      assertUsable();
      return search(index, query, options);
    },

    autoSuggest(query, options) {
      assertUsable();
      return autoSuggest(index, query, options);
    },
  };
}

function indexedState(
  prepared: OkfPreparedDocument,
): IndexedDocumentState {
  const { projection } = prepared;
  const recordIds = nonEmptyRecordIds(
    projection.records.map((record) => record.id),
  );

  if (prepared.conformance === "strict") {
    const firstRecord = prepared.projection.records[0];
    return {
      path: projection.path,
      type: projection.type,
      recordIds,
      conformance: "strict",
      status: firstRecord.status,
      trustTier: firstRecord.trustTier,
    };
  }

  const firstRecord = prepared.projection.records[0];
  return {
    path: projection.path,
    type: projection.type,
    recordIds,
    conformance: "degraded",
    ...(firstRecord.status === undefined ? {} : { status: firstRecord.status }),
    ...(firstRecord.trustTier === undefined ? {} : { trustTier: firstRecord.trustTier }),
    diagnostics: copyNonEmptyDiagnostics(prepared.diagnostics),
  };
}

function nonEmptyRecordIds(ids: string[]): NonEmptyRecordIds {
  const first = ids[0];
  if (!first) throw new Error("OKF projection requires at least one record ID");
  return [first, ...ids.slice(1)];
}

function copyNonEmptyDiagnostics(
  diagnostics: NonEmptyDiagnostics,
): NonEmptyDiagnostics {
  return [
    { ...diagnostics[0] },
    ...diagnostics.slice(1).map((item) => ({ ...item })),
  ];
}

function applyLogicalStats(
  stats: MutableLogicalIndexStats,
  state: IndexedDocumentState,
  delta: 1 | -1,
): boolean {
  stats.total += delta;
  stats[state.conformance] += delta;
  const typesChanged = updateTypeCount(stats.types, state.type, delta);

  const status = state.status ?? "unclassified";
  stats.statuses[status] += delta;

  const trustTier = trustTierBucket(state.trustTier);
  stats.trustTiers[trustTier] += delta;

  return typesChanged;
}

function trustTierBucket(
  trustTier: OkfTrustTier | undefined,
): keyof OkfLogicalIndexStats["trustTiers"] {
  switch (trustTier) {
    case "unverified":
      return "unverified";
    case "machine-confirmed":
      return "machineConfirmed";
    case "human-reviewed":
      return "humanReviewed";
    default:
      return "unclassified";
  }
}

function updateTypeCount(
  typeCounts: Map<string, number>,
  type: string,
  delta: 1 | -1,
): boolean {
  const current = typeCounts.get(type) ?? 0;
  const next = current + delta;

  if (next === 0) typeCounts.delete(type);
  else typeCounts.set(type, next);

  return current === 0 || next === 0;
}

function createTypeSnapshot(
  typeCounts: ReadonlyMap<string, number>,
): readonly string[] {
  return Object.freeze([...typeCounts.keys()].sort(comparePaths));
}

function createIndexStatsSnapshot(
  stats: MutableLogicalIndexStats,
  index: MiniSearch<OkfIndexRecord>,
): OkfIndexStats {
  const types = Object.freeze(
    [...stats.types.entries()]
      .sort(([left], [right]) => comparePaths(left, right))
      .map(([type, documentCount]) =>
        Object.freeze({ type, documentCount })),
  );
  const logical = Object.freeze({
    documents: Object.freeze({
      total: stats.total,
      strict: stats.strict,
      degraded: stats.degraded,
    }),
    types,
    statuses: Object.freeze({
      draft: stats.statuses.draft,
      stable: stats.statuses.stable,
      deprecated: stats.statuses.deprecated,
      unclassified: stats.statuses.unclassified,
    }),
    trustTiers: Object.freeze({
      unverified: stats.trustTiers.unverified,
      machineConfirmed: stats.trustTiers.machineConfirmed,
      humanReviewed: stats.trustTiers.humanReviewed,
      unclassified: stats.trustTiers.unclassified,
    }),
  });

  const serialized = JSON.stringify(index);
  if (serialized === undefined) {
    throw new Error("MiniSearch index serialization returned undefined");
  }

  return Object.freeze({
    logical,
    storage: Object.freeze({
      kind: "serialized-index" as const,
      format: "minisearch-json-utf8" as const,
      sizeInBytes: new TextEncoder().encode(serialized).byteLength,
    }),
  });
}

function assertOwnedRecordIds(
  index: MiniSearch<OkfIndexRecord>,
  documentId: string,
  ids: NonEmptyRecordIds,
): void {
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id) => !index.has(id))
  ) {
    throw new Error(`OKF index ownership is inconsistent for ${documentId}`);
  }
}

function addRecords(
  index: MiniSearch<OkfIndexRecord>,
  records: readonly OkfIndexRecord[],
): void {
  index.addAll(cloneRecords(records));
}

function cloneRecords(
  records: readonly OkfIndexRecord[],
): OkfIndexRecord[] {
  return records.map((record) => ({
    ...record,
    tags: [...record.tags],
  }));
}

function createIndex(): MiniSearch<OkfIndexRecord> {
  return new MiniSearch<OkfIndexRecord>({
    fields: [
      "resource",
      "title",
      "headingPath",
      "description",
      "tags",
      "type",
      "sourceText",
      "text",
    ],
    storeFields: [
      "documentId",
      "conformance",
      "title",
      "path",
      "type",
      "tags",
      "status",
      "staleAfter",
      "staleAfterEpoch",
      "stalenessClassified",
      "trustTier",
      "headingPath",
      "text",
      "startLine",
      "endLine",
    ],
  });
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
