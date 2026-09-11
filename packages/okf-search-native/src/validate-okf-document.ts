import { NativeOkfSearch } from "../native.cjs";
import type { OkfDocumentInput, OkfValidationResult } from "./types.js";

export function validateOkfDocument(input: OkfDocumentInput): OkfValidationResult {
  return NativeOkfSearch.validateRaw(input) as OkfValidationResult;
}
