export { OkfError } from "./errors.js";
export type { OkfErrorCode } from "./errors.js";

export { validateOkfDocument } from "./ingest.js";
export { createOkfSearch } from "./create-okf-search.js";
export { openOkf } from "./open-okf.js";

export type {
  IsoDateTime,
  OkfAttester,
  OkfAutoSuggestOptions,
  OkfConformance,
  OkfDiagnostic,
  OkfDiagnosticCode,
  OkfDegradedDocument,
  OkfDocument,
  OkfDocumentInput,
  OkfExecutor,
  OkfGeneration,
  OkfIndexStats,
  OkfIndexStorageStats,
  OkfIngestResult,
  OkfLogicalIndexStats,
  OkfParameter,
  OkfSearch,
  OkfSearchField,
  OkfSearchHit,
  OkfSearchOptions,
  OkfSource,
  OkfStatus,
  OkfSuggestion,
  OkfTimeWindow,
  OkfTrustTier,
  OkfValidationResult,
  OkfVerification,
} from "./types.js";
