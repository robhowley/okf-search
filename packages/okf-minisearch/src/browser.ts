import { createOkfSearch } from "./create-okf-search.js";
import { OkfError } from "./errors.js";
import { normalizeDocumentIdentity } from "./ingest.js";

import type {
  OkfDocumentInput,
  OkfSearch,
} from "./types.js";

const BROWSER_FILE_INPUT_ERROR =
  "Browser openOkf requires selected File objects; path strings are Node-only.";

interface BrowserCandidate {
  readonly file: File;
  readonly path: string;
  readonly documentId: string;
}

export async function openOkf(
  files: FileList | readonly File[],
): Promise<OkfSearch> {
  const input = files as unknown;
  if (typeof input === "string") {
    throw new TypeError(BROWSER_FILE_INPUT_ERROR);
  }

  const snapshot = Array.from(input as FileList | readonly File[]);
  if (snapshot.some((file) => !isBrowserFile(file))) {
    throw new TypeError(BROWSER_FILE_INPUT_ERROR);
  }

  const candidates = snapshot
    .filter((file) => isConceptFile(file.name))
    .map((file): BrowserCandidate => {
      const identity = normalizeDocumentIdentity(browserPath(file));
      return {
        file,
        path: identity.path,
        documentId: identity.documentId,
      };
    })
    .sort((left, right) => comparePaths(left.path, right.path));

  const documentIds = new Set<string>();
  for (const candidate of candidates) {
    if (documentIds.has(candidate.documentId)) {
      throw new OkfError(
        "ERR_OKF_FIELD",
        candidate.path,
        { field: "path" },
      );
    }
    documentIds.add(candidate.documentId);
  }

  const documents: OkfDocumentInput[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });

  for (const candidate of candidates) {
    let contents: ArrayBuffer;
    try {
      contents = await candidate.file.arrayBuffer();
    } catch (cause) {
      throw new OkfError("ERR_OKF_READ", candidate.path, { cause });
    }

    let markdown: string;
    try {
      markdown = decoder.decode(contents);
    } catch (cause) {
      throw new OkfError("ERR_OKF_PARSE", candidate.path, { cause });
    }

    documents.push({
      path: candidate.path,
      markdown,
    });
  }

  return createOkfSearch(documents);
}

function browserPath(file: File): string {
  if (!file.webkitRelativePath) return file.name;

  const separator = file.webkitRelativePath.indexOf("/");
  return separator < 0
    ? ""
    : file.webkitRelativePath.slice(separator + 1);
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isConceptFile(filename: string): boolean {
  return filename.endsWith(".md") &&
    filename !== "index.md" &&
    filename !== "log.md";
}

function isBrowserFile(value: unknown): value is File {
  if (!value || typeof value !== "object") return false;

  const candidate = value as {
    name?: unknown;
    arrayBuffer?: unknown;
    webkitRelativePath?: unknown;
  };
  return typeof candidate.name === "string" &&
    typeof candidate.arrayBuffer === "function" &&
    (candidate.webkitRelativePath === undefined ||
      typeof candidate.webkitRelativePath === "string");
}

export { OkfError } from "./errors.js";
export { createOkfSearch } from "./create-okf-search.js";
export { validateOkfDocument } from "./ingest.js";

export type { OkfErrorCode } from "./errors.js";
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
