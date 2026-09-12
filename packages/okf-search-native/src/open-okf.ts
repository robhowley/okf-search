import { NativeOkfSearch } from "../native.cjs";
import { wrapNative } from "./create-okf-search.js";
import { throwNativeError } from "./errors.js";
import type { OkfSearch } from "./types.js";

export async function openOkf(root: string): Promise<OkfSearch> {
  try {
    return wrapNative(await NativeOkfSearch.openRaw(root));
  } catch (error) {
    throwNativeError(error, "<index>");
  }
}
