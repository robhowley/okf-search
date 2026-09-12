export interface DocumentInput {
  path: string;
  markdown: string;
}

/** Addon transport only: identity and fallback have already been normalized. */
export interface NativeInput extends DocumentInput {
  documentId: string;
  fallbackTitle: string;
}

export interface Diagnostic {
  code: "ERR_OKF_PARSE" | "ERR_OKF_FIELD";
  message: string;
  path: string;
  field?: string;
}

export interface TimeWindow {
  from: string;
  to: string;
}

export interface StaleAfter {
  value: string;
  epochMillis: number;
}

/** The core's projection, not the full PreparedOkfDocument contract. */
export interface ProjectedFields {
  type: string;
  title: string;
  description?: string;
  resource?: string;
  tags: string[];
  sources: {
    resource: string;
    id?: string;
    title?: string;
    author?: string;
    usageCount?: number;
    lastModified?: string;
    usageWindow?: TimeWindow;
  }[];
  sourceText: string;
  usageWindow?: TimeWindow;
  generated?: { by: string; at?: string };
  verified: { by: string; at: string }[];
  trustTier?: "unverified" | "machine-confirmed" | "human-reviewed";
  status?: "draft" | "stable" | "deprecated";
  staleAfter?: StaleAfter;
  staleness: { classified: boolean; staleAfter?: StaleAfter };
  runtime?: string;
  parameters?: { name: string; type: string; required: boolean }[];
  computation?: string;
  executor?: { resource: string; receipt: string[] };
  attester?: { resource: string };
}

export interface PreparedSection {
  id: string;
  headingPath: string;
  text: string;
  startLine: number;
  endLine: number;
}

export type PreparationResult =
  | { kind: "fatal"; diagnostics: [Diagnostic, ...Diagnostic[]] }
  | {
    kind: "accepted";
    identity: { path: string; documentId: string };
    conformance: "strict" | "degraded";
    fields: ProjectedFields;
    body: string;
    bodyStartLine: number;
    sections: PreparedSection[];
    diagnostics: Diagnostic[];
  };

export interface ValidationResult {
  isValid: boolean;
  isIndexable: boolean;
  errors: Diagnostic[];
}
