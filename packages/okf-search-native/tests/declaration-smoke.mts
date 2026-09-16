import {
  OkfError,
  createOkfSearch,
  openOkf,
  validateOkfDocument,
} from "okf-search-native";
import type {
  IsoDateTime,
  OkfAttester,
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
  OkfIndexStorageStats,
  OkfLogicalIndexStats,
  OkfOpenOptions,
  OkfIngestResult,
  OkfParameter,
  OkfSearch,
  OkfSearchField,
  OkfSearchHit,
  OkfSearchOptions,
  OkfSource,
  OkfStatus,
  OkfTimeWindow,
  OkfTrustTier,
  OkfValidationResult,
  OkfVerification,
} from "okf-search-native";
import {
  NativeOkfSearch,
  type PreparedDocument,
  type SearchOptions as PreparedSearchOptions,
} from "okf-search-native/prepared";
// @ts-expect-error Generated bindings stay at the prepared subpath.
import type { NativeOkfSearch as RootNativeOkfSearch } from "okf-search-native";
// @ts-expect-error Suggestion DTOs are not part of the friendly root.
import type { OkfSuggestion } from "okf-search-native";
// @ts-expect-error Preparation implementation types are private.
import type { PrepareError } from "okf-search-native";

type Same<T, U> =
  (<V>() => V extends T ? 1 : 2) extends
  (<V>() => V extends U ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type ExactPreparedRemove = Assert<Same<
  NativeOkfSearch["removeDocument"],
  (documentId: string) => boolean
>>;
type ExactNativeOpen = Assert<Same<
  typeof NativeOkfSearch.openRaw,
  (root: string, cachePath?: string | null) => Promise<NativeOkfSearch>
>>;
type ExactNativeSave = Assert<Same<
  NativeOkfSearch["save"],
  (path: string) => Promise<void>
>>;

type ExactErrorCode = Assert<Same<
  OkfErrorCode,
  | "ERR_OKF_READ"
  | "ERR_OKF_PARSE"
  | "ERR_OKF_FIELD"
  | "ERR_OKF_CACHE_INVALID"
  | "ERR_OKF_CACHE_INCOMPATIBLE"
  | "ERR_OKF_WRITE"
  | "ERR_OKF_CACHE_BUSY"
  | "ERR_OKF_INDEX_UNUSABLE"
  | "ERR_OKF_UNSUPPORTED"
>>;
type ExactOpenOptions = Assert<Same<
  OkfOpenOptions,
  { readonly cachePath?: string }
>>;
type ExactOpen = Assert<Same<
  typeof openOkf,
  (root: string, options?: OkfOpenOptions) => Promise<OkfSearch>
>>;
type ExactSave = Assert<Same<
  OkfSearch["save"],
  (path: string) => Promise<void>
>>;
type ExactDiagnosticCode = Assert<Same<
  OkfDiagnosticCode,
  "ERR_OKF_PARSE" | "ERR_OKF_FIELD"
>>;
type ExactConformance = Assert<Same<OkfConformance, "strict" | "degraded">>;
type ExactStatus = Assert<Same<OkfStatus, "draft" | "stable" | "deprecated">>;
type ExactTrustTier = Assert<Same<
  OkfTrustTier,
  "unverified" | "machine-confirmed" | "human-reviewed"
>>;
type ExactSearchField = Assert<Same<
  OkfSearchField,
  | "resource"
  | "title"
  | "heading"
  | "description"
  | "tags"
  | "type"
  | "sources"
  | "body"
>>;
type ExactSearchKeys = Assert<Same<
  keyof OkfSearchOptions,
  "limit" | "snippetLength" | "where" | "asOf" | "match" | "fields" | "boost" | "fuzzy"
>>;
type ExactWhereKeys = Assert<Same<
  keyof NonNullable<OkfSearchOptions["where"]>,
  "types" | "tagsAny" | "statuses" | "trustTiers" | "stale" | "conformance"
>>;
type ExactAutoSuggest = Assert<Same<
  OkfSearch["autoSuggest"],
  (query: string, options?: OkfSearchOptions) => never
>>;
type ExactIndexStats = Assert<Same<
  OkfSearch["indexStats"],
  () => OkfIndexStats
>>;
type ExactIndexStorageStats = Assert<Same<
  OkfIndexStorageStats,
  | {
      readonly kind: "in-memory-index-files";
      readonly sizeInBytes: number;
    }
  | {
      readonly kind: "serialized-index";
      readonly format: "minisearch-json-utf8";
      readonly sizeInBytes: number;
    }
>>;
type ExactIndexStorageSize = Assert<Same<
  OkfIndexStats["storage"]["sizeInBytes"],
  number
>>;

const unsupported = new OkfError("ERR_OKF_UNSUPPORTED", "autoSuggest");
const rootHandle: OkfSearch = createOkfSearch([]);
const opened: Promise<OkfSearch> = openOkf(".", { cachePath: ".cache/okf" });
const saved: Promise<void> = rootHandle.save(".cache/okf");
const validation: OkfValidationResult = validateOkfDocument({
  path: "types.md",
  markdown: "---\ntype: note\n---\n",
});
declare const stats: OkfIndexStats;
const sizeInBytes: number = stats.storage.sizeInBytes;
const options: OkfSearchOptions = {
  snippetLength: 240,
  match: "all",
  fields: ["title", "heading", "body"] as const,
  where: {
    statuses: ["stable"] as const,
    trustTiers: ["human-reviewed"] as const,
    conformance: ["strict"] as const,
  },
};

declare const prepared: PreparedDocument[];
const native = NativeOkfSearch.fromPrepared(prepared);
const preparedOptions: PreparedSearchOptions = { match: "all" };
native.search("memory", preparedOptions);
native.removeDocument("prepared");
// @ts-expect-error Prepared removal accepts only a document ID.
native.removeDocument({ documentId: "prepared", path: "prepared.md" });

void [
  unsupported,
  rootHandle,
  opened,
  saved,
  validation,
  options,
  null as ExactErrorCode | null,
  null as ExactOpenOptions | null,
  null as ExactOpen | null,
  null as ExactSave | null,
  null as ExactNativeOpen | null,
  null as ExactNativeSave | null,
  null as ExactDiagnosticCode | null,
  null as ExactConformance | null,
  null as ExactStatus | null,
  null as ExactTrustTier | null,
  null as ExactSearchField | null,
  null as ExactSearchKeys | null,
  null as ExactWhereKeys | null,
  null as ExactAutoSuggest | null,
  null as ExactIndexStats | null,
  null as ExactIndexStorageStats | null,
  null as ExactIndexStorageSize | null,
  null as OkfIndexStorageStats | null,
  sizeInBytes,
  null as OkfLogicalIndexStats | null,
  null as ExactPreparedRemove | null,
  null as IsoDateTime | null,
  null as OkfAttester | null,
  null as OkfDiagnostic | null,
  null as OkfDegradedDocument | null,
  null as OkfDocument | null,
  null as OkfDocumentInput | null,
  null as OkfExecutor | null,
  null as OkfGeneration | null,
  null as OkfIngestResult | null,
  null as OkfParameter | null,
  null as OkfSearchHit | null,
  null as OkfSource | null,
  null as OkfTimeWindow | null,
  null as OkfValidationResult | null,
  null as OkfVerification | null,
  null as RootNativeOkfSearch | null,
  null as OkfSuggestion | null,
  null as PrepareError | null,
];
