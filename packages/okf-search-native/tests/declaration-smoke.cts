import {
  OkfError,
  createOkfSearch,
  openOkf,
  validateOkfDocument,
  type OkfIndexStats,
  type OkfIndexStorageStats,
  type OkfLogicalIndexStats,
  type OkfOpenOptions,
  type OkfSearch,
  type OkfSearchOptions,
  type OkfValidationResult,
} from "okf-search-native";
import {
  NativeOkfSearch,
  type PreparedDocument,
} from "okf-search-native/prepared";

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
type ExactAutoSuggest = Assert<Same<
  OkfSearch["autoSuggest"],
  (query: string, options?: OkfSearchOptions) => never
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

const error = new OkfError("ERR_OKF_UNSUPPORTED", "autoSuggest");
const rootHandle: OkfSearch = createOkfSearch([]);
const opened: Promise<OkfSearch> = openOkf(".", { cachePath: ".cache/okf" });
const saved: Promise<void> = rootHandle.save(".cache/okf");
const validation: OkfValidationResult = validateOkfDocument({
  path: "types.md",
  markdown: "---\ntype: note\n---\n",
});
declare const stats: OkfIndexStats;
const sizeInBytes: number = stats.storage.sizeInBytes;
declare const prepared: PreparedDocument[];
const native = NativeOkfSearch.fromPrepared(prepared);
native.removeDocument("prepared");
// @ts-expect-error Prepared removal accepts only a document ID.
native.removeDocument({ documentId: "prepared", path: "prepared.md" });

void [
  error,
  rootHandle,
  opened,
  saved,
  validation,
  native,
  null as ExactAutoSuggest | null,
  null as ExactOpenOptions | null,
  null as ExactOpen | null,
  null as ExactSave | null,
  null as ExactNativeOpen | null,
  null as ExactNativeSave | null,
  null as ExactIndexStats | null,
  null as ExactIndexStorageStats | null,
  null as ExactIndexStorageSize | null,
  null as OkfIndexStorageStats | null,
  sizeInBytes,
  null as OkfLogicalIndexStats | null,
  null as ExactPreparedRemove | null,
];
