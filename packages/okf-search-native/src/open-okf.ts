import { NativeOkfSearch } from "../native.cjs";
import { wrapNative } from "./create-okf-search.js";
import { OkfError, throwNativeError } from "./errors.js";
import type { OkfOpenOptions, OkfSearch } from "./types.js";

export async function openOkf(
  root: string,
  options?: OkfOpenOptions,
): Promise<OkfSearch> {
  const { cachePath, storage } = snapshotOpenOptions(options);

  try {
    return wrapNative(await NativeOkfSearch.openRaw(root, cachePath, storage));
  } catch (error) {
    throwNativeError(error, "<index>");
  }
}

function snapshotOpenOptions(options: OkfOpenOptions | null | undefined): {
  cachePath?: string;
  storage?: "memory" | "mmap";
} {
  if (options == null) {
    return {};
  }
  if (typeof options !== "object") {
    throw new OkfError("ERR_OKF_FIELD", "<input>", { field: "options" });
  }

  // Snapshot each caller-owned getter once. Native receives only these values.
  const cachePath = (options as { readonly cachePath?: unknown }).cachePath;
  const storage = (options as { readonly storage?: unknown }).storage;
  if (cachePath !== undefined && typeof cachePath !== "string") {
    throw new OkfError("ERR_OKF_FIELD", "<input>", { field: "cachePath" });
  }
  if (storage !== undefined && storage !== "memory" && storage !== "mmap") {
    throw new OkfError("ERR_OKF_FIELD", "<input>", { field: "storage" });
  }
  if (storage === "mmap" && cachePath === undefined) {
    throw new OkfError("ERR_OKF_FIELD", "<input>", { field: "cachePath" });
  }

  return {
    ...(cachePath === undefined ? {} : { cachePath }),
    ...(storage === undefined ? {} : { storage }),
  };
}
