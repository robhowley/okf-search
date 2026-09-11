import type { OkfErrorCode } from "./types.js";

interface OkfErrorOptions {
  readonly field?: string;
  readonly cause?: unknown;
}

export class OkfError extends Error {
  readonly code: OkfErrorCode;
  readonly path: string;
  declare readonly field?: string;

  constructor(
    code: OkfErrorCode,
    path: string,
    options: OkfErrorOptions = {},
  ) {
    super(
      message(code, path, options.field),
      options.cause === undefined ? undefined : { cause: options.cause },
    );

    this.name = "OkfError";
    this.code = code;
    this.path = path;

    if (options.field !== undefined) {
      this.field = options.field;
    }
  }
}

function message(
  code: OkfErrorCode,
  path: string,
  field: string | undefined,
): string {
  const subject = field ? `${path} (${field})` : path;

  switch (code) {
    case "ERR_OKF_READ":
      return `Cannot read OKF path: ${subject}`;
    case "ERR_OKF_PARSE":
      return `Cannot parse OKF concept: ${subject}`;
    case "ERR_OKF_FIELD":
      return `Invalid OKF field: ${subject}`;
    case "ERR_OKF_INDEX_UNUSABLE":
      return path === "<index>"
        ? "Search index is permanently unusable and must be rebuilt"
        : `Search index failed while mutating ${path}; this OkfSearch handle is permanently unusable and must be rebuilt`;
    case "ERR_OKF_UNSUPPORTED":
      return `Unsupported OKF operation: ${path}`;
  }
}

export const POISON_MARKER = /^\[ERR_OKF_INDEX_UNUSABLE\](?: |$)/;
const NATIVE_MARKER = /^\[ERR_OKF_[A-Z_]+\](?: |$)/;
const INVALID_SEARCH_OPTIONS_MARKER =
  /^\[ERR_OKF_INVALID_SEARCH_OPTIONS\](?: |$)/;

export function throwNativeError(error: unknown, path: string): never {
  const message = nativeMessage(error);
  if (!NATIVE_MARKER.test(message)) throw error;

  if (typeof error === "object" && error !== null && "code" in error && "path" in error) {
    const detail = error as { code: string; path: string; field?: string; cause?: unknown };
    if (detail.code === "ERR_OKF_FIELD" || detail.code === "ERR_OKF_PARSE" || detail.code === "ERR_OKF_READ") {
      throw new OkfError(detail.code, detail.path, {
        ...(detail.field === undefined ? {} : { field: detail.field }),
        ...(detail.cause === undefined ? {} : { cause: new Error(String(detail.cause)) }),
      });
    }
  }
  if (POISON_MARKER.test(message)) {
    throw new OkfError("ERR_OKF_INDEX_UNUSABLE", path);
  }

  const sanitized = message.replace(NATIVE_MARKER, "").trim();
  throw INVALID_SEARCH_OPTIONS_MARKER.test(message)
    ? new TypeError(sanitized)
    : new Error(sanitized || "Native OKF search failed");
}

export function nativeMessage(error: unknown): string {
  // Callers must finish executing caller-owned code before entering translation.
  const message = error instanceof Error
    ? Object.getOwnPropertyDescriptor(error, "message")?.value
    : undefined;
  return typeof message === "string" ? message : "";
}
