import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { PrepareError, prepareOkfDocument } from "../dist/index.js";
import { parseOkfYaml } from "../dist/yaml.js";

const output = resolve("test/fixtures/phase-1-parity-v1.json");

const yamlCases = [
  {
    id: "yaml-1.2-values",
    source: [
      "type: note",
      "scalars: [null, true, false, 0, -0, 0o17, 0x10, 1e3, .nan, .inf, -.inf, 2026-08-24]",
      "quoted: [\"null\", 'true', \"\\uD800\", \"\\uDC00\", \"\\uD800\\uDC00\"]",
      "nested: {plain: value, list: [one, two]}",
    ].join("\n"),
  },
  {
    id: "leading-bom-before-non-string-key",
    sourceUnits: utf16("\uFEFF1: value"),
  },
  {
    id: "double-leading-bom-removes-only-the-first",
    sourceUnits: utf16("\uFEFF\uFEFF1: value"),
  },
  {
    id: "non-leading-bom-remains-a-string-key",
    sourceUnits: utf16("type: note\n\uFEFF1: value"),
  },
  {
    id: "aliases-and-cycles",
    source: [
      "type: note",
      "first: &shared {value: shared}",
      "second: *shared",
      "cycle: &cycle {self: *cycle}",
      "sequence: &sequence [*shared, *shared]",
    ].join("\n"),
  },
  {
    id: "tagged-values",
    source: [
      "type: note",
      "date: !!timestamp 2026-08-24",
      "map: !!map {one: 1}",
      "ordered: !!omap [{first: one}, {second: two}]",
      "pairs: !!pairs [{first: one}, {second: two}]",
      "set: !!set {first: null, second: null}",
      "binary: !!binary SGVsbG8=",
      "unknownScalar: !application/custom value",
      "unknownSequence: !application/custom [one, two]",
      "unknownMapping: !application/custom {one: two}",
    ].join("\n"),
  },
  {
    id: "yaml-1.1-values-and-merge",
    source: [
      "%YAML 1.1",
      "---",
      "type: note",
      "legacy: [yes, NO, 012, 0b10, 1:20, 2001-12-15]",
      "base: &base {first: one}",
      "merged: {<<: *base, second: two}",
    ].join("\n"),
  },
  {
    id: "yaml-1.1-invalid-explicit-timestamp-falls-back",
    source: "%YAML 1.1\n---\ntype: note\nvalue: !!timestamp nope",
  },
  {
    id: "yaml-1.1-valid-explicit-timestamp-remains-date",
    source: "%YAML 1.1\n---\ntype: note\nvalue: !!timestamp 2026-08-24",
  },
  {
    id: "yaml-1.1-explicit-timestamp-collection-falls-back",
    source: "%YAML 1.1\n---\ntype: note\nvalue: !!timestamp [nope]",
  },
  {
    id: "yaml-1.2-invalid-explicit-timestamp-remains-fatal",
    source: "type: note\nvalue: !!timestamp nope",
  },
  {
    id: "yaml-1.2-explicit-timestamp-collection-falls-back",
    source: "type: note\nvalue: !!timestamp [nope]",
  },
  {
    id: "yaml-1.1-explicit-timestamp-alias-property-remains-fatal",
    source: "%YAML 1.1\n---\ntype: note\nvalue: !!timestamp *missing",
  },
  {
    id: "surrogate-values-and-marker-collisions",
    sourceUnits: utf16([
      "type: note",
      "escaped: \"\\uD800\"",
      `literal: "${String.fromCharCode(0xD800)}"`,
      `collisions: "${String.fromCodePoint(0xF0000)}${String.fromCodePoint(0xF0001)}"`,
    ].join("\n")),
  },
  {
    id: "javascript-own-property-order",
    source: [
      "type: note",
      "first: 1",
      "\"10\": ten",
      "\"2\": two",
      "second: 2",
      "\"01\": leading",
    ].join("\n"),
  },
  {
    id: "accepted-string-key-forms",
    source: [
      "type: note",
      "\"1\": quoted",
      "!!str true: explicit",
      "!application/custom tagged: unknown",
      "anchor: &key aliased",
      "? *key",
      ": alias",
      "base: &base {merged: yes}",
      "result: {!!merge <<: *base, direct: yes}",
    ].join("\n"),
  },
  {
    id: "alias-resolved-object-collisions",
    source: [
      "type: note",
      "firstKey: &firstKey first",
      "? *firstKey",
      ": alias-first",
      "first: direct-last",
      "second: direct-first",
      "secondKey: &secondKey second",
      "? *secondKey",
      ": alias-last",
      "thirdKey: &thirdKey third",
      "? *thirdKey",
      ": first-alias",
      "? *thirdKey",
      ": second-alias",
    ].join("\n"),
  },
  {
    id: "alias-resolved-set-collisions",
    source: [
      "type: note",
      "key: &key duplicate",
      "extension: !!set",
      "  ? duplicate",
      "  ? *key",
      "  ? *key",
    ].join("\n"),
  },
  {
    id: "tagged-set-implicit-null-values",
    source: "type: note\nextension: !!set {empty:, bare, null: null, tilde: ~}",
  },
  {
    id: "tagged-set-inside-pairs",
    source: "type: note\nextension: !!pairs [!!set {a: null}]",
  },
  {
    id: "tagged-set-inside-omap",
    source: "type: note\nextension: !!omap [!!set {a: null}]",
  },
  {
    id: "tagged-set-merge-source",
    source: "base: &base !!set {x: null}\nmerged: {!!merge anything: *base}",
  },
  {
    id: "tagged-set-merge-string-iteration",
    source: "base: &base !!set {\"\": null, x: null, shared: null, \"😀x\": null}\nmerged: {!!merge anything: *base}",
  },
  {
    id: "multiple-tagged-set-merge-sources",
    source: [
      "first: &first !!set {x: null, same: null}",
      "second: &second !!set {solo: null, y: null}",
      "merged: {!!merge anything: [*first, *second]}",
    ].join("\n"),
  },
  {
    id: "map-and-tagged-set-merge-precedence",
    source: [
      "map: &map {s: map, mapOnly: value}",
      "set: &set !!set {shared: null, setOnly: null}",
      "mapFirst: {!!merge anything: [*map, *set]}",
      "setFirst: {!!merge anything: [*set, *map]}",
      "direct: {!!merge anything: *set, s: direct}",
    ].join("\n"),
  },
  {
    id: "tagged-set-merge-preserves-alias-identity",
    source: [
      "base: &base !!set {first: null, second: null}",
      "alias: *base",
      "merged: {!!merge anything: *base}",
    ].join("\n"),
  },
  {
    id: "omap-explicit-merge-symbol-key-rejected",
    source: "type: note\nextension: !!omap [{!!merge <<: {a: b}}]",
  },
  {
    id: "yaml-1.1-omap-merge-symbol-key-rejected",
    source: "%YAML 1.1\n---\ntype: note\nextension: !!omap [{<<: {a: b}}]",
  },
  {
    id: "yaml-1.1-anchored-implicit-merge-alias-value",
    source: [
      "%YAML 1.1",
      "---",
      "type: note",
      "base: &base {a: b}",
      "&merge <<: *base",
      "aliasValue: *merge",
    ].join("\n"),
  },
  {
    id: "yaml-1.1-anchored-implicit-merge-alias-key",
    source: [
      "%YAML 1.1",
      "---",
      "type: note",
      "base: &base {a: b}",
      "&merge <<: *base",
      "? *merge",
      ": value",
    ].join("\n"),
  },
  {
    id: "omap-alias-equivalent-source-pairs",
    source: [
      "type: note",
      "key: &key duplicate",
      "extension: !!omap",
      "  -",
      "    ? *key",
      "    : first",
      "    duplicate: second",
    ].join("\n"),
  },
  {
    id: "pairs-alias-equivalent-source-pairs",
    source: [
      "type: note",
      "key: &key duplicate",
      "extension: !!pairs",
      "  -",
      "    ? *key",
      "    : first",
      "    duplicate: second",
    ].join("\n"),
  },
  {
    id: "pairs-single-merge-source-pair",
    source: "type: note\nextension: !!pairs [{!!merge <<: {a: b, c: d}}]",
  },
  {
    id: "pairs-preserves-value-anchor",
    source: "type: note\nextension: !!pairs [{a: &value kept}]\nafter: *value",
  },
  {
    id: "normal-sequence-preserves-mapping-anchor",
    source: "type: note\nextension: [&mapping {a: null}]\nafter: *mapping",
  },
  {
    id: "pairs-preserves-outer-anchor",
    source: "type: note\nextension: &pairs !!pairs [{a: null}]\nafter: *pairs",
  },
  ...[
    ["pairs-empty-entry", "type: note\nextension: !!pairs [{}]"],
    ["pairs-two-source-pairs", "type: note\nextension: !!pairs [{a: b, c: d}]"],
    ["pairs-merge-plus-direct-source-pairs", "type: note\nextension: !!pairs [{!!merge <<: {a: b}, c: d}]"],
    ["pairs-tagged-set-with-two-source-pairs", "type: note\nextension: !!pairs [!!set {a: null, b: null}]"],
    ["pairs-tagged-set-with-non-null-value", "type: note\nextension: !!pairs [!!set {a: value}]"],
    ["pairs-consumes-mapping-anchor-before-self-reference", "type: note\nextension: !!pairs [&mapping {self: *mapping}]"],
    ["pairs-consumes-mapping-anchor-before-after-reference", "type: note\nextension: !!pairs [&mapping {a: null}]\nafter: *mapping"],
    ["omap-consumes-mapping-anchor-before-self-reference", "type: note\nextension: !!omap [&mapping {self: *mapping}]"],
    ["omap-consumes-mapping-anchor-before-after-reference", "type: note\nextension: !!omap [&mapping {a: null}]\nafter: *mapping"],
  ].map(([id, source]) => ({ id, source })),
  {
    id: "alias-limit-near-threshold-accepted",
    source: [
      "type: note",
      "a: &a [x]",
      "b: &b [*a, *a]",
      `accepted: [${Array.from({ length: 32 }, () => "*b").join(", ")}]`,
    ].join("\n"),
  },
  ...[
    ["non-string-root-number", "type: note\n1: value"],
    ["non-string-root-float", "type: note\n1.5: value"],
    ["non-string-root-explicit-int", "type: note\n!!int 1: value"],
    ["non-string-root-boolean", "type: note\ntrue: value"],
    ["non-string-root-null", "type: note\nnull: value"],
    ["non-string-root-date", "type: note\n!!timestamp 2026-08-24: value"],
    ["non-string-root-binary", "type: note\n!!binary SGVsbG8=: value"],
    ["non-string-root-symbol", "type: note\n!!merge anything: value"],
    ["non-string-root-sequence", "type: note\n? [one, two]\n: value"],
    ["non-string-root-map", "type: note\n? {one: two}\n: value"],
    ["non-string-nested", "type: note\nextension: {1: value}"],
    ["non-string-alias-number", "type: note\nnumber: &number 1\n? *number\n: value"],
    ["non-string-alias-map", "type: note\nmap: &map {one: two}\n? *map\n: value"],
    ["non-string-alias-merge-symbol", "type: note\nsymbol: &symbol !!merge value\n? *symbol\n: value"],
    ["non-string-set", "type: note\nextension: !!set {1: null}"],
    ["duplicate-string-set-key", "type: note\nextension: !!set\n  ? duplicate\n  ? duplicate"],
    ["tagged-set-explicit-null-value", "type: note\nextension: !!set {a: !!null null}"],
    ["invalid-tagged-set-merge-source-value", "base: &base !!set {x: value}\nmerged: {!!merge anything: *base}"],
    ["scalar-merge-source", "base: &base value\nmerged: {!!merge anything: *base}"],
    ["sequence-with-non-map-merge-source", "base: &base [value]\nmerged: {!!merge anything: *base}"],
    ["non-string-omap", "type: note\nextension: !!omap [{1: value}]"],
    ["non-string-pairs", "type: note\nextension: !!pairs [{1: value}]"],
    ["non-string-merge-source", "type: note\nbase: &base {1: value}\nextension: {!!merge <<: *base}"],
    ["malformed", "type: ["],
    ["duplicate-key", "type: note\ntype: guide"],
    ["multiple-documents", "type: note\n---\ntype: guide"],
    ["unknown-alias", "type: note\nextension: *missing"],
    ["alias-limit-over-threshold", [
      "type: note",
      "a: &a [x]",
      "b: &b [*a, *a]",
      `rejected: [${Array.from({ length: 33 }, () => "*b").join(", ")}]`,
    ].join("\n")],
  ].map(([id, source]) => ({ id, source })),
];

const fixture = {
  schemaVersion: 10,
  dependencies: {
    yaml: "2.9.0",
  },
  yaml: yamlCases.map(({ id, source, sourceUnits }) => {
    const input = source ?? String.fromCharCode(...sourceUnits);
    return {
      id,
      ...(sourceUnits === undefined ? { source } : { sourceUnits }),
      outcome: yamlOutcome(input),
    };
  }),
  representation: representationFixture(),
  utf16Order: ["\u{10000}", "\uE000", "\uD800", "a", "\uDC00"]
    .sort()
    .map(utf16),
  prepareParseError: capturePrepareParseError(),
  outerFrontmatterBomParseError: captureOuterFrontmatterBomParseError(),
};

const encoded = `${JSON.stringify(fixture, null, 2)}\n`;
if (process.argv.includes("--update")) {
  await writeFile(output, encoded, "utf8");
  console.log(`updated ${output}`);
} else {
  const expected = await readFile(output, "utf8");
  if (expected !== encoded) {
    throw new Error(`Phase 1 fixture is stale; run ${process.argv[1]} --update`);
  }
  console.log(`verified ${output}`);
}

function yamlOutcome(source) {
  try {
    return { kind: "return", value: encodePortable(parseOkfYaml(source)) };
  } catch {
    const error = capturePrepareParseError(source);
    return {
      kind: "throw",
      diagnostic: {
        code: error.code,
        path: error.path,
        message: error.message,
      },
    };
  }
}

function capturePrepareParseError(yaml = "[") {
  try {
    prepareOkfDocument({
      path: "oracle/yaml.md",
      markdown: `---\n${yaml}\n---\nbody`,
    });
  } catch (error) {
    return prepareErrorShape(error);
  }
  if (/(?:^|\n)---(?:\n|$)/.test(yaml)) {
    const error = new PrepareError("ERR_OKF_PARSE", "oracle/yaml.md");
    return {
      name: error.name,
      code: error.code,
      path: error.path,
      message: error.message,
      fieldPresent: Object.hasOwn(error, "field"),
      causePresent: Object.hasOwn(error, "cause"),
      ownEnumerableKeys: Object.keys(error),
      ownPropertyNames: Object.getOwnPropertyNames(error),
    };
  }
  throw new Error("Expected preparation to throw PrepareError");
}

function captureOuterFrontmatterBomParseError() {
  try {
    prepareOkfDocument({
      path: "oracle/outer-bom.md",
      markdown: "\uFEFF---\ntype: note\n---\nbody",
    });
  } catch (error) {
    return prepareErrorShape(error);
  }
  throw new Error("Expected outer frontmatter BOM to remain invalid");
}

function prepareErrorShape(error) {
  if (!(error instanceof PrepareError)) throw error;
  return {
    name: error.name,
    code: error.code,
    path: error.path,
    message: error.message,
    fieldPresent: Object.hasOwn(error, "field"),
    causePresent: Object.hasOwn(error, "cause"),
    ownEnumerableKeys: Object.keys(error),
    ownPropertyNames: Object.getOwnPropertyNames(error),
  };
}

function representationFixture() {
  const shared = { marker: "shared" };
  const cycle = { shared };
  cycle.self = cycle;
  const sparse = [];
  sparse.length = 3;
  sparse[1] = undefined;
  const sharedSymbol = Symbol("shared");
  return encodePortable({
    absent: {},
    explicitUndefined: { value: undefined },
    sparse,
    numbers: [0, -0, Number.NaN, Infinity, -Infinity, 1.5],
    strings: ["café", "\uD800", "\uDC00", "\u{10000}"],
    order: { "10": "ten", first: 1, "2": "two", second: 2 },
    aliases: { first: shared, second: shared, cycle },
    symbols: {
      first: sharedSymbol,
      alias: sharedSymbol,
      distinct: Symbol("shared"),
      anonymous: Symbol(),
    },
    date: new Date("2026-08-24T00:00:00.000Z"),
    map: new Map([[shared, "object key"], ["second", cycle]]),
    set: new Set([shared, "second"]),
    bytes: Buffer.from([0, 1, 254, 255]),
  });
}

function encodePortable(value) {
  const references = new Map();
  const symbols = new Map();
  let nextReference = 0;
  let nextSymbol = 0;

  function encode(current) {
    if (current === null) return ["null"];
    switch (typeof current) {
      case "undefined": return ["undefined"];
      case "boolean": return ["boolean", current];
      case "string": return ["string", utf16(current)];
      case "number": return ["number", numberBits(current)];
      case "symbol": {
        let identity = symbols.get(current);
        if (identity === undefined) {
          identity = nextSymbol++;
          symbols.set(current, identity);
        }
        return [
          "symbol",
          identity,
          current.description === undefined ? null : utf16(current.description),
        ];
      }
      case "object": break;
      default: throw new TypeError(`unsupported fixture value: ${typeof current}`);
    }

    const prior = references.get(current);
    if (prior !== undefined) return ["reference", prior];
    const reference = nextReference++;
    references.set(current, reference);

    if (Array.isArray(current)) {
      return ["array", reference, current.length, Object.keys(current).map((key) =>
        [utf16(key), encode(current[key])])];
    }
    if (current instanceof Date) {
      return ["date", reference, numberBits(current.getTime())];
    }
    if (current instanceof Map) {
      return ["map", reference, [...current].map(([key, item]) =>
        [encode(key), encode(item)])];
    }
    if (current instanceof Set) {
      return ["set", reference, [...current].map(encode)];
    }
    if (ArrayBuffer.isView(current)) {
      return [
        "array-buffer-view",
        reference,
        current.constructor.name,
        Buffer.from(current.buffer, current.byteOffset, current.byteLength).toString("base64"),
      ];
    }
    return [
      "object",
      reference,
      Object.getPrototypeOf(current) === null ? "null-prototype" : "object-prototype",
      Object.keys(current).map((key) => [utf16(key), encode(current[key])]),
    ];
  }

  return encode(value);
}

function utf16(value) {
  return Array.from({ length: value.length }, (_, index) => value.charCodeAt(index));
}

function numberBits(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleBE(value);
  return bytes.toString("hex");
}
