/**
 * Encodes JavaScript values without collapsing distinctions that JSON loses.
 * Object IDs are assigned in encounter order, so aliases and cycles are stable.
 */
export function encodeStructural(value) {
  const references = new Map();
  let nextReference = 0;

  function encode(current, path) {
    if (current === null) return ["null"];

    switch (typeof current) {
      case "undefined":
        return ["undefined"];
      case "boolean":
        return ["boolean", current];
      case "string":
        // JSON.stringify escapes lone surrogates while retaining ordinary UTF-8.
        return ["string", current];
      case "number":
        return ["number", encodeNumber(current)];
      case "bigint":
        return ["bigint", current.toString(10)];
      case "symbol":
      case "function":
        throw new TypeError(`Unsupported ${typeof current} at ${path}`);
      case "object":
        break;
      default:
        throw new TypeError(`Unsupported value at ${path}`);
    }

    const existing = references.get(current);
    if (existing !== undefined) return ["reference", existing];

    const reference = nextReference;
    nextReference += 1;
    references.set(current, reference);

    if (Array.isArray(current)) {
      return [
        "array",
        reference,
        current.length,
        Object.keys(current).map((key) => [
          key,
          encode(current[key], childPath(path, key)),
        ]),
      ];
    }

    if (current instanceof Date) {
      return ["date", reference, encodeNumber(current.getTime())];
    }

    if (current instanceof Map) {
      return [
        "map",
        reference,
        [...current].map(([key, item], index) => [
          encode(key, `${path}/<map-key-${index}>`),
          encode(item, `${path}/<map-value-${index}>`),
        ]),
      ];
    }

    if (current instanceof Set) {
      return [
        "set",
        reference,
        [...current].map((item, index) =>
          encode(item, `${path}/<set-${index}>`)),
      ];
    }

    if (ArrayBuffer.isView(current)) {
      return [
        "array-buffer-view",
        reference,
        current.constructor.name,
        Buffer.from(current.buffer, current.byteOffset, current.byteLength)
          .toString("base64"),
      ];
    }

    if (current instanceof ArrayBuffer) {
      return [
        "array-buffer",
        reference,
        Buffer.from(current).toString("base64"),
      ];
    }

    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(
        `Unsupported ${current.constructor?.name ?? "object"} at ${path}`,
      );
    }

    return [
      "object",
      reference,
      prototype === null ? "null-prototype" : "object-prototype",
      Object.keys(current).map((key) => [
        key,
        encode(current[key], childPath(path, key)),
      ]),
    ];
  }

  return Buffer.from(`${JSON.stringify(encode(value, "$"))}\n`, "utf8");
}

export function byteDifference(expected, actual) {
  const length = Math.min(expected.length, actual.length);
  let offset = 0;
  while (offset < length && expected[offset] === actual[offset]) offset += 1;
  if (offset === length && expected.length === actual.length) return undefined;

  const start = Math.max(0, offset - 40);
  const end = offset + 80;
  return {
    offset,
    expectedBytes: expected.length,
    actualBytes: actual.length,
    expected: expected.subarray(start, end).toString("utf8"),
    actual: actual.subarray(start, end).toString("utf8"),
  };
}

function encodeNumber(value) {
  if (Number.isNaN(value)) return "nan";
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeDoubleBE(value);
  return buffer.toString("hex");
}

function childPath(path, key) {
  return `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}
