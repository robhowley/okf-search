import { oracleInputs } from "./oracle-inputs.mjs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fingerprintCorpusFiles } from "./corpus-support.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const demoRoot = resolve(packageRoot, "../../demo/assets/sample-bundle");
const filesystemFixtureRoot = resolve(packageRoot, "test/fixtures/filesystem");

export const ORACLE_SCHEMA_VERSION = 1;

export async function captureOracle(rootApi, nodeApi, shuffleSeed = 0) {
  const cases = oracleInputs();
  const strictInput = cases[0].input;

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
