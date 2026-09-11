import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { oracleInputs } from "../../okf-prepare/scripts/oracle-inputs.mjs";
import { assertPrivateCorpus, PRIVATE_CORPUS } from "../../okf-prepare/scripts/corpus-support.mjs";
import { smallInputs, transportExclusion, yamlIds } from "../scripts/comparison-inputs.mjs";
import { capture, compareCaptures, decode, differences, encode, project, validatePreparation, validateValidation } from "../scripts/comparison-values.mjs";
import { captureInput, parseArgs, runChild } from "../scripts/compare-js.mjs";
import * as js from "../../okf-prepare/dist/index.js";
import * as native from "../dist/index.js";

const input = (yaml = "type: note", body = "body") => ({ path: "synthetic/note.md", markdown: `---\n${yaml}\n---\n${body}` });

test("fixed inventory: 10 oracle, 12 YAML, 8 focused, 42 demo; exactly one transport exclusion", async () => {
  const entries = await smallInputs();
  assert.equal(oracleInputs().length, 10);
  assert.equal(yamlIds.length, 12);
  assert.equal(entries.length, 72);
  assert.equal(new Set(entries.map((e) => e.id)).size, 72);
  assert.deepEqual(entries.filter((e) => e.nativeExcluded).map((e) => e.id), [transportExclusion]);
  assert.equal(entries.filter((e) => e.id.startsWith("demo/")).length, 42);
  assert.equal(entries.find((e) => e.id === "empty-body").input.markdown, "---\ntype: note\n---\n");
  const chunk = entries.find((e) => e.id === "chunk-800-words").input.markdown.split("---\n")[2];
  assert.equal(chunk.split(/\s+/).length, 800);
  assert.equal(chunk.split("\n\n").length, 8);
});

test("private corpus gate rejects any changed count, size or fingerprint", () => {
  assert.doesNotThrow(() => assertPrivateCorpus(PRIVATE_CORPUS));
  for (const key of ["documents", "bytes", "manifestFingerprint"]) assert.throws(() => assertPrivateCorpus({ ...PRIVATE_CORPUS, [key]: null }));
});

test("tree and typed capture preserve absence, undefined, null, false, zero and scalar types", () => {
  for (const [a, b] of [[{}, { x: undefined }], [{ x: undefined }, { x: null }], [false, 0], [0, "0"], [0, -0], [NaN, null], [Infinity, -Infinity], [[1, 2], [2, 1]], [new Array(1), [undefined]], [[], {}]]) assert.ok(differences(a, b).length);
  const value = { undefined: undefined, values: [null, false, 0, -0, NaN, Infinity, -Infinity, "\ud800"], sparse: new Array(2) };
  assert.deepEqual(differences(value, decode(JSON.parse(JSON.stringify(encode(value))))), []);
  assert.deepEqual(differences({ a: 1, b: 2 }, { b: 2, a: 1 }), []);
  assert.deepEqual(differences(NaN, NaN), []);
  assert.deepEqual(differences({}, { x: undefined })[0].left, ["missing"]);
});

test("validate independent raw shapes, including nested extras and ordered diagnostics", () => {
  for (const engine of ["js", "native"]) {
    const prepared = engine === "js" ? js.prepareOkfDocument(input()) : native.prepare(input());
    validatePreparation(engine, prepared);
    for (const mutate of [
      (v) => { delete v.identity.path; },
      (v) => { v.sections[0].text = null; },
      (v) => { (engine === "js" ? v.document : v.fields).sources = [{ resource: "x", usageCount: "0" }]; },
      (v) => { v.diagnostics = [{}]; },
    ]) {
      const malformed = structuredClone(prepared); mutate(malformed);
      assert.throws(() => project(engine, malformed), /Malformed/);
    }
  }
  assert.throws(() => validateValidation({ isValid: true, isIndexable: false, errors: [] }), /Malformed/);
  assert.throws(() => validateValidation({ isValid: false, isIndexable: false, errors: [{ code: "ERR_OKF_FIELD", message: "x", path: "p", field: null }] }), /Malformed/);
});

test("both stale representations compare for strict and degraded, without reparsing or truthiness", () => {
  for (const degraded of [false, true]) {
    for (const timestamp of ["1970-01-01T00:00:00Z", "1970-01-01T00:00:00.0001Z"]) {
      const document = input(`type: note\n${degraded ? "title: 1\n" : ""}stale_after: ${timestamp}`);
      const j = capture("js", js, document);
      const n = capture("native", native, document);
      assert.equal(j.preparation.staleAfter.staleAfter, timestamp);
      assert.equal(n.preparation.staleAfter.staleAfter, timestamp);
      assert.ok(Object.hasOwn(j.preparation.staleAfter, "staleAfterEpoch"));
      const raw = native.prepare(document);
      raw.fields.staleAfter.epochMillis = 123;
      const changed = { ...n, preparation: project("native", raw) };
      assert.ok(compareCaptures(j, changed).some((d) => d.path.includes('["staleAfter"]["staleAfterEpoch"]')));
      raw.fields.staleness.staleAfter.value = "not reparsed";
      assert.ok(compareCaptures(j, { ...n, preparation: project("native", raw) }).some((d) => d.path.includes('["facets"]["staleness"]["staleAfter"]')));
    }
  }
  const missing = project("js", js.prepareOkfDocument(input()));
  const invalid = project("js", js.prepareOkfDocument(input("type: note\nstale_after: invalid")));
  assert.equal(missing.staleAfter.classified, true);
  assert.equal(invalid.staleAfter.classified, false);
  assert.equal(Object.hasOwn(missing.staleAfter, "staleAfter"), false);
});

test("fatal diagnostics use all validation errors, not selected PrepareError", () => {
  const document = input("title: 1\nsources: [{}]");
  const result = capture("js", js, document);
  assert.equal(result.preparation.kind, "fatal");
  assert.ok(result.validation.errors.length > 1);
  assert.ok(result.prepareError.code);
  const equivalent = { validation: result.validation, preparation: { kind: "fatal", diagnostics: result.validation.errors } };
  assert.deepEqual(compareCaptures(result, equivalent), []);
  assert.ok(compareCaptures(result, { ...equivalent, preparation: { kind: "fatal", diagnostics: result.validation.errors.slice(0, 1) } }).length);
  assert.ok(compareCaptures(result, capture("native", native, input())).some((d) => d.path === "preparation.kind"));
});

test("projection retains optional own undefined and checks document identity independently", () => {
  const raw = js.prepareOkfDocument(input());
  assert.equal(Object.hasOwn(project("js", raw).metadata, "description"), false);
  raw.metadata.description = undefined;
  const present = project("js", raw);
  assert.equal(Object.hasOwn(present.metadata, "description"), true);
  const independent = capture("native", native, input());
  assert.ok(compareCaptures({ validation: independent.validation, preparation: present }, independent).some((d) => d.path.includes("description")));
  const j = capture("js", js, input());
  j.preparation.strict.id = "different";
  assert.ok(compareCaptures(j, independent).some((d) => d.path === "js.documentIdentityAgreement"));
});

test("strict nested extras compare, degraded-only extras are excluded", () => {
  const j = capture("js", js, input('type: note\nparameters: [{name: "", type: "", required: false}]'));
  const n = structuredClone(j); n.preparation.strict.parameters[0].required = true;
  assert.ok(compareCaptures(j, n).some((d) => d.path.includes("required")));
  const degraded = structuredClone(n); degraded.preparation.conformance = "degraded";
  assert.equal(compareCaptures(j, degraded).filter((d) => d.path.startsWith("preparation.strict")).length, 0);
});

test("unexpected exceptions and nondeterminism are execution failures", () => {
  const entry = { id: "synthetic", input: input() };
  assert.throws(() => captureInput(entry, { ...js, prepareOkfDocument() { throw new Error("unexpected"); } }, native), /unexpected/);
  let calls = 0;
  assert.throws(() => captureInput(entry, { ...js, prepareOkfDocument(document) { const result = js.prepareOkfDocument(document); result.metadata.title = String(calls++); return result; } }, native), /Nondeterministic/);
  const reused = js.prepareOkfDocument(entry.input);
  assert.throws(() => captureInput(entry, { ...js, prepareOkfDocument() { reused.metadata.title = String(calls++); return reused; } }, native), /Nondeterministic/);
  assert.equal(captureInput({ ...entry, nativeExcluded: true }, js, { prepare() { throw new Error("must not call"); } }).native.length, 0);
});

test("real sequential child captures synthetic inputs twice with private typed artifacts", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "okf-comparison-test-"));
  try {
    const request = resolve(directory, "inputs.json");
    const result = resolve(directory, "captures.jsonl");
    await writeFile(request, JSON.stringify(encode([{ id: "synthetic", input: input() }, { id: "synthetic-fatal", input: input("title: missing") }])));
    await runChild(request, result);
    const records = (await readFile(result, "utf8")).trim().split("\n").map((line) => decode(JSON.parse(line)));
    assert.equal(records.length, 2);
    for (const record of records) {
      assert.equal(record.js.length, 2); assert.equal(record.native.length, 2);
      assert.deepEqual(differences(record.js[0], record.js[1]), []);
      assert.deepEqual(differences(record.native[0], record.native[1]), []);
    }
    await assert.rejects(runChild(request, resolve(directory, "timeout.jsonl"), 1), /failed or timed out/);
    await writeFile(request, JSON.stringify(encode(Array.from({ length: 257 }, (_, i) => ({ id: String(i), input: input() })))));
    const rejected = resolve(directory, "oversized.jsonl");
    await assert.rejects(runChild(request, rejected), /failed or timed out/);
    assert.equal(JSON.parse(await readFile(`${rejected}.error.json`, "utf8")).message, "Invalid chunk");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("CLI only accepts fixed suites and explicit output", () => {
  assert.equal(parseArgs(["--suite", "small", "--out", "/tmp/private"]).suite, "small");
  for (const args of [[], ["--suite", "other", "--out", "/tmp/private"], ["--suite", "corpus", "--out", "/tmp/private", "--corpus", "/tmp/alternate"]]) assert.throws(() => parseArgs(args));
});
