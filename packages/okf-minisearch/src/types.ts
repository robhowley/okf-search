import type {
  OkfStatus,
  OkfTrustTier,
} from "./vocabulary.js";

export type {
  OkfStatus,
  OkfTrustTier,
} from "./vocabulary.js";

export type IsoDateTime = string;

export interface OkfTimeWindow {
  from: IsoDateTime;
  to: IsoDateTime;
}

export interface OkfSource {
  id?: string;
  resource: string;
  title?: string;
  author?: string;
  usageCount?: number;
  lastModified?: IsoDateTime;
  usageWindow?: OkfTimeWindow;
}

export interface OkfGeneration {
  by: string;
  at?: IsoDateTime;
}

export interface OkfVerification {
  by: string;
  at: IsoDateTime;
}

export interface OkfParameter {
  name: string;
  type: string;
  required: boolean;
}

export interface OkfExecutor {
  resource: string;
  receipt: string[];
}

export interface OkfAttester {
  resource: string;
}

export interface OkfDocument {
  id: string;
  type: string;
  title: string;
  description?: string;
  resource?: string;
  tags: string[];

  sources: OkfSource[];
  usageWindow?: OkfTimeWindow;
  generated?: OkfGeneration;
  verified: OkfVerification[];

  status: OkfStatus;
  staleAfter?: IsoDateTime;

  runtime?: string;
  parameters?: OkfParameter[];
  computation?: string;
  executor?: OkfExecutor;
  attester?: OkfAttester;

  body: string;
  extensions: Record<string, unknown>;
}

export interface OkfReservedFile {
  path: string;
  body: string;
}

export interface OkfBundle {
  root: string;
  okfVersion?: string;
  documents: ReadonlyMap<string, OkfDocument>;
  indexes: ReadonlyMap<string, OkfReservedFile>;
  logs: ReadonlyMap<string, OkfReservedFile>;
}

export interface OkfDocumentInput {
  /**
   * Relative POSIX identity. Empty and `.` segments normalize away;
   * case and `\` remain significant.
   */
  path: string;
  markdown: string;
}

export type OkfDiagnosticCode =
  | "ERR_OKF_PARSE"
  | "ERR_OKF_FIELD";

export interface OkfDiagnostic {
  code: OkfDiagnosticCode;
  path: string;
  field?: string;
  message: string;
}

export type OkfValidationResult =
  | {
      readonly isValid: true;
      readonly isIndexable: true;
      readonly errors: readonly [];
    }
  | {
      readonly isValid: false;
      readonly isIndexable: true;
      readonly errors: readonly [OkfDiagnostic, ...OkfDiagnostic[]];
    }
  | {
      readonly isValid: false;
      readonly isIndexable: false;
      readonly errors: readonly [OkfDiagnostic, ...OkfDiagnostic[]];
    };

export interface OkfDegradedDocument {
  readonly documentId: string;
  readonly path: string;
  readonly diagnostics: readonly [OkfDiagnostic, ...OkfDiagnostic[]];
}

export type OkfConformance = "strict" | "degraded";

export type OkfIngestResult =
  | { readonly conformance: "strict"; readonly document: OkfDocument }
  | ({ readonly conformance: "degraded" } & OkfDegradedDocument);

export type OkfSearchField =
  | "resource"
  | "title"
  | "heading"
  | "description"
  | "tags"
  | "type"
  | "sources"
  | "body";

export interface OkfSearchOptions {
  limit?: number;

  where?: {
    types?: readonly string[];
    tagsAny?: readonly string[];
    statuses?: readonly OkfStatus[];
    trustTiers?: readonly OkfTrustTier[];
    stale?: boolean;
    conformance?: readonly OkfConformance[];
  };

  asOf?: Date;

  match?: "any" | "all";
  fields?: readonly OkfSearchField[];
  boost?: Readonly<Partial<Record<OkfSearchField, number>>>;
  fuzzy?: boolean | number;
}

export type OkfAutoSuggestOptions = OkfSearchOptions;

export interface OkfSuggestion {
  readonly suggestion: string;
  readonly terms: readonly string[];
  readonly score: number;
}

export interface OkfSearchHit {
  documentId: string;
  title: string;
  sectionId: string;
  score: number;
  conformance: OkfConformance;
  matchedFields: OkfSearchField[];

  headingPath: string;
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
}

export interface OkfLogicalIndexStats {
  readonly documents: {
    readonly total: number;
    readonly strict: number;
    readonly degraded: number;
  };
  readonly types: readonly {
    readonly type: string;
    readonly documentCount: number;
  }[];
  readonly statuses: {
    readonly draft: number;
    readonly stable: number;
    readonly deprecated: number;
    readonly unclassified: number;
  };
  readonly trustTiers: {
    readonly unverified: number;
    readonly machineConfirmed: number;
    readonly humanReviewed: number;
    readonly unclassified: number;
  };
}

export type OkfIndexStorageStats =
  | {
      readonly kind: "in-memory-index-files";
      readonly indexFileBytes: number;
    }
  | {
      readonly kind: "serialized-index";
      readonly format: "minisearch-json-utf8";
      readonly serializedIndexBytes: number;
    }
  | {
      readonly kind: "unavailable";
    };

export interface OkfIndexStats {
  readonly logical: OkfLogicalIndexStats;
  readonly storage: OkfIndexStorageStats;
}

export interface OkfSearch {
  ingest(input: OkfDocumentInput): OkfIngestResult;

  listDegradedDocuments(): readonly OkfDegradedDocument[];

  listTypes(): readonly string[];

  indexStats(): OkfIndexStats;

  remove(path: string): boolean;

  search(
    query: string,
    options?: OkfSearchOptions,
  ): OkfSearchHit[];

  autoSuggest(
    query: string,
    options?: OkfAutoSuggestOptions,
  ): OkfSuggestion[];
}