// Import only identity/error code: the preparation barrel also loads JS parsers.
import { normalizeOkfDocumentIdentity } from "../../okf-prepare/src/identity.js";
import { PrepareError } from "../../okf-prepare/src/errors.js";
import native from "../native.cjs";
import type { Diagnostic, DocumentInput, NativeInput, PreparationResult, ValidationResult } from "./types.js";

export type { Diagnostic, DocumentInput, PreparationResult, PreparedSection, ProjectedFields, ValidationResult } from "./types.js";

function nativeInput(input: DocumentInput): NativeInput | Diagnostic {
  if (input === null || typeof input !== "object"
    || typeof input.path !== "string" || typeof input.markdown !== "string") {
    throw new TypeError("Expected { path: string, markdown: string }");
  }
  let identity;
  try {
    identity = normalizeOkfDocumentIdentity(input.path);
  } catch (error) {
    if (!(error instanceof PrepareError) || error.code !== "ERR_OKF_FIELD") throw error;
    return {
      code: error.code,
      message: error.message,
      path: error.path,
      ...(error.field === undefined ? {} : { field: error.field }),
    };
  }
  const title = (identity.documentId.split("/").at(-1) ?? identity.documentId)
    .replace(/[-_]+/g, " ");
  return {
    ...identity,
    fallbackTitle: title.charAt(0).toUpperCase() + title.slice(1),
    markdown: input.markdown,
  };
}

export function prepare(input: DocumentInput): PreparationResult {
  const value = nativeInput(input);
  return "code" in value ? { kind: "fatal", diagnostics: [value] } : native.prepare(value);
}

export function validate(input: DocumentInput): ValidationResult {
  const value = nativeInput(input);
  return "code" in value
    ? { isValid: false, isIndexable: false, errors: [value] }
    : native.validate(value);
}
