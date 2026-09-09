import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fingerprintCorpusFiles } from "./corpus-support.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const demoRoot = resolve(packageRoot, "../../demo/assets/sample-bundle");
const filesystemFixtureRoot = resolve(packageRoot, "test/fixtures/filesystem");

export const ORACLE_SCHEMA_VERSION = 1;

export async function captureOracle(rootApi, nodeApi, shuffleSeed = 0) {
  const strictInput = input("oracle/strict.md", `
    type: note
    title: Oracle strict
    description: ''
    resource: resource://strict
    tags: [alpha, beta]
    sources:
      - resource: source://one
        id: source-one
        author: human:alice
        usage_count: -1.5
        last_modified: 2026-08-24T10:00:00Z
    usage_window:
      from: 2026-01-01T00:00:00Z
      to: 2026-12-31T23:59:59.1239+01:00
    generated:
      by: process:oracle
      at: 2026-08-24T10:00:00Z
    verified:
      - by: process:builder
        at: 2026-08-24T10:00:00Z
      - by: human:alice
        at: 2026-08-25T10:00:00Z
    status: deprecated
    stale_after: 2027-01-01T00:00:00Z
    runtime: node
    parameters:
      - name: query
        type: string
        required: true
    computation: resource://computation
    executor:
      resource: resource://executor
      receipt: [resource://receipt]
    attester:
      resource: resource://attester
    extension_graph: &graph
      self: *graph
    extension_shared: &shared
      value: shared
    extension_alias: *shared
    extension_nan: .nan
    extension_positive_infinity: .inf
    extension_negative_infinity: -.inf
    extension_negative_zero: -0
    extension_surrogate: "\\uD800"
    extension_date: !!timestamp 2026-08-24
    extension_map: !!omap
      - first: one
      - second: two
    extension_set: !!set
      first:
      second:
    extension_binary: !!binary SGVsbG8=
  `, [
    "# Escaped &amp; [linked](resource) ![image alt](image)",
    "paragraph one",
    "",
    "Setext child",
    "------------",
    "paragraph two",
    "",
    "> # nested quote heading",
    "",
    "- # nested list heading",
    "",
    "```md",
    "# fenced heading",
    "```",
    "",
    "<div>html block</div>",
    "",
    "[resource]: https://example.com",
  ].join("\n"));

  const cases = [
    { id: "strict-rich-yaml-and-markdown", input: strictInput },
    {
      id: "degraded-diagnostic-order",
      input: input("oracle/degraded.md", `
        attester: {}
        status: future
        sources:
          - {}
        type: note
        tags: [ok, 2]
        verified: [{}]
      `, "degraded body"),
    },
    {
      id: "fatal-missing-type",
      input: input("oracle/missing-type.md", "title: Missing type", "body"),
    },
    {
      id: "fatal-duplicate-yaml-key",
      input: input("oracle/duplicate-key.md", "type: note\ntype: guide", "body"),
    },
    {
      id: "line-endings-crlf",
      input: withLineEndings(input(
        "oracle/crlf.md",
        "type: note",
        "# Parent\n\n## Child\nline ending body",
      ), "\r\n"),
    },
    {
      id: "line-endings-lone-cr-body",
      input: {
        path: "oracle/lone-cr.md",
        markdown: "---\ntype: note\n---\n# Parent\rbody\rnext",
      },
    },
    {
      id: "chunk-801-words",
      input: input(
        "oracle/chunk.md",
        "type: note",
        Array.from({ length: 7 }, () => words(100))
          .concat(words(101))
          .join("\n\n"),
      ),
    },
    {
      id: "lone-surrogate-path-and-body",
      input: input("oracle/\uD800.md", "type: note", "# \uD800\nbody \uD800"),
    },
    {
      id: "batch-order-astral",
      input: input("oracle/\u{10000}.md", "type: astral", "astral path"),
    },
    {
      id: "batch-order-private-use",
      input: input("oracle/\uE000.md", "type: private-use", "private-use path"),
    },
  ];

  const packageManifest = JSON.parse(await readFile(
    resolve(packageRoot, "package.json"),
    "utf8",
  ));
  const demoManifest = JSON.parse(await readFile(
    resolve(demoRoot, "manifest.json"),
    "utf8",
  ));
  const { files: demoFiles, ...demoFingerprint } =
    await fingerprintCorpusFiles(demoRoot);
  assertDemoManifest(demoManifest, demoFingerprint, demoFiles);
  const demoInputs = await nodeApi.readOkfDocuments(demoRoot);
  const shuffledDemoInputs = shuffle(demoInputs, shuffleSeed);
  const demoPrepared = rootApi.prepareOkfDocuments(shuffledDemoInputs);
  const filesystemInputs = await nodeApi.readOkfDocuments(filesystemFixtureRoot);
  const filesystemPrepared = rootApi.prepareOkfDocuments(filesystemInputs);
  const richStrict = rootApi.prepareOkfDocument(strictInput);
  const degraded = rootApi.prepareOkfDocument(cases[1].input);

  return {
    schemaVersion: ORACLE_SCHEMA_VERSION,
    dependencies: {
      "mdast-util-from-markdown": packageManifest.dependencies["mdast-util-from-markdown"],
      yaml: packageManifest.dependencies.yaml,
    },
    exports: {
      root: Object.keys(rootApi).sort(),
      node: Object.keys(nodeApi).sort(),
    },
    fixtureInventory: {
      oracleCases: cases.map(({ id }) => id),
      demo: demoManifest,
    },
    shapeInventory: {
      strictPrepared: keys(richStrict),
      strictIdentity: keys(richStrict.identity),
      strictMetadata: keys(richStrict.metadata),
      strictFacets: keys(richStrict.facets),
      strictSection: keys(richStrict.sections[0]),
      strictDocument: richStrict.conformance === "strict"
        ? keys(richStrict.document)
        : [],
      degradedPrepared: keys(degraded),
      degradedDiagnostic: keys(degraded.diagnostics[0]),
      validationStrict: keys(rootApi.validateOkfDocument(strictInput)),
      validationDegraded: keys(rootApi.validateOkfDocument(cases[1].input)),
      prepareError: errorContract(new rootApi.PrepareError(
        "ERR_OKF_FIELD",
        "oracle/error.md",
        { field: "title", cause: new TypeError("not serialized") },
      )),
    },
    encoderContract: encoderContract(),
    identities: [
      "./nested//note.md",
      "folder\\literal.md",
      "\u{10000}.md",
      "\uE000.md",
      "index.md",
      "../unsafe.md",
    ].map((path) => ({ path, outcome: outcome(() =>
      rootApi.normalizeOkfDocumentIdentity(path)) })),
    documents: cases.map(({ id, input: document }) => ({
      id,
      validation: outcome(() => rootApi.validateOkfDocument(document)),
      preparation: outcome(() => rootApi.prepareOkfDocument(document)),
    })),
    batch: outcome(() => rootApi.prepareOkfDocuments(shuffle(
      cases.filter(({ id }) => !id.startsWith("fatal-"))
        .map(({ input: document }) => document),
      shuffleSeed,
    ))),
    filesystem: {
      read: filesystemInputs,
      prepared: filesystemPrepared,
    },
    errors: [
      new rootApi.PrepareError("ERR_OKF_READ", "oracle/read.md"),
      new rootApi.PrepareError("ERR_OKF_PARSE", "oracle/parse.md", {
        field: "frontmatter",
      }),
      new rootApi.PrepareError("ERR_OKF_FIELD", "oracle/field.md", {
        field: "",
        cause: new Error("not serialized"),
      }),
    ].map(errorContract),
    demo: {
      manifestFingerprint: demoFingerprint,
      read: demoInputs,
      prepared: demoPrepared,
      sections: demoPrepared.reduce(
        (total, document) => total + document.sections.length,
        0,
      ),
      degradedDocuments: demoPrepared.filter(
        ({ conformance }) => conformance === "degraded",
      ).length,
    },
  };
}

function outcome(operation) {
  try {
    return { kind: "return", value: operation() };
  } catch (error) {
    return { kind: "throw", error: errorContract(error) };
  }
}

function errorContract(error) {
  if (!(error instanceof Error)) {
    return { category: typeof error, value: String(error) };
  }
  return {
    ownEnumerableKeys: Object.keys(error),
    ownPropertyNames: Object.getOwnPropertyNames(error)
      .filter((key) => key !== "stack"),
    name: error.name,
    message: error.message,
    ...(Object.hasOwn(error, "code") ? { code: error.code } : {}),
    ...(Object.hasOwn(error, "path") ? { path: error.path } : {}),
    ...(Object.hasOwn(error, "field") ? { field: error.field } : {}),
    cause: Object.hasOwn(error, "cause")
      ? { present: true, category: error.cause?.constructor?.name ?? typeof error.cause }
      : { present: false },
  };
}

function encoderContract() {
  const shared = { marker: "shared" };
  const cycle = { shared };
  cycle.self = cycle;
  const sparse = [];
  sparse.length = 2;
  sparse[1] = undefined;

  return {
    ordered: { "10": "integer key", first: 1, second: 2 },
    missingAndUndefined: { present: undefined },
    numbers: [0, -0, Number.NaN, Infinity, -Infinity, 1.5],
    strings: ["UTF-8 café", "lone high \uD800", "lone low \uDC00"],
    aliases: { first: shared, second: shared, cycle },
    sparse,
    bigint: 9_007_199_254_740_993n,
    date: new Date("2026-08-24T00:00:00.000Z"),
    map: new Map([[shared, "object key"], ["second", cycle]]),
    set: new Set([shared, "second"]),
    bytes: Buffer.from([0, 1, 254, 255]),
  };
}

function input(path, metadata, body) {
  const lines = metadata.split("\n");
  while (!lines[0]?.trim()) lines.shift();
  while (!lines.at(-1)?.trim()) lines.pop();
  const indentation = Math.min(...lines
    .filter((line) => line.trim())
    .map((line) => line.match(/^\s*/)?.[0].length ?? 0));
  const yaml = lines.map((line) => line.slice(indentation)).join("\n");
  return { path, markdown: `---\n${yaml}\n---\n${body}` };
}

function withLineEndings(document, newline) {
  return { ...document, markdown: document.markdown.replaceAll("\n", newline) };
}

function words(count) {
  return Array.from({ length: count }, () => "word").join(" ");
}

function keys(value) {
  return Object.keys(value);
}

function shuffle(values, seed) {
  const result = [...values];
  let state = (seed + 1) >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const selected = state % (index + 1);
    [result[index], result[selected]] = [result[selected], result[index]];
  }
  return result;
}

function assertDemoManifest(manifest, fingerprint, files) {
  if (
    manifest.documentCount !== 42
    || manifest.totalBytes !== 57_038
    || fingerprint.documents !== manifest.documentCount
    || fingerprint.bytes !== manifest.totalBytes
  ) {
    throw new Error("Demo fixture manifest does not match its files");
  }

  const expected = new Map(manifest.documents.map(({ path, bytes }) => [path, bytes]));
  if (expected.size !== manifest.documents.length) {
    throw new Error("Demo fixture manifest contains duplicate paths");
  }
  if (
    files.length !== manifest.documents.length
    || files.some(({ path, bytes }) => expected.get(path) !== bytes)
  ) {
    throw new Error("Demo fixture manifest entries do not match their files");
  }
}
