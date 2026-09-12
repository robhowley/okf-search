import type { NativeInput, PreparationResult, ValidationResult } from "./src/types.js";

declare const native: {
  prepare(input: NativeInput): PreparationResult;
  validate(input: NativeInput): ValidationResult;
};
export = native;
