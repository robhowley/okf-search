import { NativeOkfSearch } from "../native.cjs";
import { wrapNative } from "./create-okf-search.js";
import { throwNativeError } from "./errors.js";
import type { OkfOpenOptions, OkfSearch } from "./types.js";

export async function openOkf(
  root: string,
  options?: OkfOpenOptions,
): Promise<OkfSearch> {
  const cachePath = options?.cachePath;

  try {
    return wrapNative(await NativeOkfSearch.openRaw(root, cachePath));
  } catch (error) {
    throwNativeError(error, "<index>");
  }
}
