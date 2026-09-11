import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prepare, validate } from "okf-prepare-native";

const native = createRequire(import.meta.url)("../native.cjs");
const document = (yaml, body = "", path = "note.md") => ({
  path,
  markdown: `---\n${yaml}\n---\n${body}`,
});
const fieldError = (field, path = "note.md") => ({
  code: "ERR_OKF_FIELD",
  message: `Invalid OKF field: ${path} (${field})`,
  path,
  field,
});
const parseError = {
  code: "ERR_OKF_PARSE",
  message: "Cannot parse OKF concept: note.md",
  path: "note.md",
};

// Expected values follow the core domain/content contracts, not a JS oracle.
test("strict preparation normalizes identity, derives title, and projects inclusive section lines", () => {
  const input = document("type: note", "preamble\n\n# Parent\n### Grandchild\nchild text\n## Child\nchild body", "./notes//foo-bar.md");
  assert.deepEqual(prepare(input), {
    kind: "accepted",
    identity: { path: "notes/foo-bar.md", documentId: "notes/foo-bar" },
    conformance: "strict",
    fields: {
      type: "note", title: "Foo bar", tags: [], sources: [], sourceText: "",
      verified: [], trustTier: "unverified", status: "stable", staleness: { classified: true },
    },
    body: "preamble\n\n# Parent\n### Grandchild\nchild text\n## Child\nchild body",
    bodyStartLine: 4,
    diagnostics: [],
    sections: [
      { id: "notes/foo-bar#root", headingPath: "Foo bar", text: "preamble", startLine: 4, endLine: 4 },
      { id: "notes/foo-bar#parent", headingPath: "Parent", text: "", startLine: 6, endLine: 6 },
      { id: "notes/foo-bar#parent-grandchild", headingPath: "Parent > Grandchild", text: "child text", startLine: 7, endLine: 8 },
      { id: "notes/foo-bar#parent-child", headingPath: "Parent > Child", text: "child body", startLine: 9, endLine: 10 },
    ],
  });
  assert.deepEqual(validate(input), { isValid: true, isIndexable: true, errors: [] });
  const empty = prepare(document('type: note\ntitle: ""'));
  assert.equal(empty.fields.title, "");
  assert.deepEqual(empty.sections, [{ id: "note#root", headingPath: "", text: "", startLine: 5, endLine: 5 }]);
});

test("raw loader calls Rust with opaque identity and explicit fallback, without JS preparation", () => {
  const input = { ...document("type: note"), documentId: "opaque\\ID", fallbackTitle: "Caller title" };
  const result = native.prepare(input);
  assert.equal(result.identity.documentId, "opaque\\ID");
  assert.equal(result.fields.title, "Caller title");
  assert.equal(result.sections[0].id, "opaque\\ID#root");
  assert.deepEqual(native.validate(input), { isValid: true, isIndexable: true, errors: [] });
  const bundle = readFileSync(new URL("../dist/index.js", import.meta.url), "utf8");
  assert.doesNotMatch(bundle, /mdast-util|yaml\/dist|function analyzeOkf|function prepareOkf/);
});

const rich = document(`type: custom type
title: ""
description: ""
resource: ../resource
tags: [one, "", one]
sources:
  - id: source-id
    title: Source title
    author: producer/version
    resource: ../source
    usage_count: -1.5
    last_modified: 2026-08-24T10:00:00Z
    usage_window:
      from: 2027-08-24T10:00:00Z
      to: 2026-08-24T10:00:00Z
  - resource: ""
    usage_count: 0
usage_window:
  from: 2027-08-24T10:00:00+01:00
  to: 2026-08-24T10:00:00Z
generated:
  by: process:builder
verified:
  by: human:alice
  at: 2026-08-24T10:00:00Z
status: deprecated
stale_after: 1970-01-01T00:00:00Z
runtime: runtime
parameters:
  - name: ""
    type: ""
    required: false
computation: ""
executor:
  resource: executor
  receipt: []
attester:
  resource: attester
unknown:
  nested: true`);

test("all projected fields retain numbers, false, empty strings, and omitted own keys", () => {
  const result = prepare(rich);
  assert.equal(result.kind, "accepted");
  assert.equal(result.conformance, "strict");
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.fields, {
    type: "custom type", title: "", description: "", resource: "../resource", tags: ["one", "", "one"],
    sources: [
      { id: "source-id", title: "Source title", author: "producer/version", resource: "../source", usageCount: -1.5,
        lastModified: "2026-08-24T10:00:00Z", usageWindow: { from: "2027-08-24T10:00:00Z", to: "2026-08-24T10:00:00Z" } },
      { resource: "", usageCount: 0 },
    ],
    sourceText: "source-id Source title producer/version ../source",
    usageWindow: { from: "2027-08-24T10:00:00+01:00", to: "2026-08-24T10:00:00Z" },
    generated: { by: "process:builder" },
    verified: [{ by: "human:alice", at: "2026-08-24T10:00:00Z" }],
    trustTier: "human-reviewed", status: "deprecated",
    staleAfter: { value: "1970-01-01T00:00:00Z", epochMillis: 0 },
    staleness: { classified: true, staleAfter: { value: "1970-01-01T00:00:00Z", epochMillis: 0 } },
    runtime: "runtime", parameters: [{ name: "", type: "", required: false }], computation: "",
    executor: { resource: "executor", receipt: [] }, attester: { resource: "attester" },
  });
  assert.equal(typeof result.fields.sources[0].usageCount, "number");
  assert.equal(typeof result.fields.staleAfter.epochMillis, "number");
  assert.equal(Object.hasOwn(result.fields.generated, "at"), false);
  assert.equal(Object.hasOwn(result.fields.sources[1], "id"), false);
  assert.equal(Object.hasOwn(result.fields, "unknown"), false);
  assert.deepEqual(validate(rich), { isValid: true, isIndexable: true, errors: [] });
});

test("present optional values and nonzero epoch milliseconds remain typed", () => {
  const input = document(`type: note
status: draft
stale_after: 1970-01-01T00:00:00.0001Z
generated: { by: process:builder, at: 1970-01-01T00:00:00Z }
verified: [{ by: process:checker, at: 1970-01-01T00:00:00Z }]
parameters: []
sources: [{ resource: "", id: "", title: "" }]`);
  const result = prepare(input);
  assert.equal(result.conformance, "strict");
  assert.equal(result.fields.status, "draft");
  assert.equal(result.fields.trustTier, "machine-confirmed");
  assert.deepEqual(result.fields.staleAfter, { value: "1970-01-01T00:00:00.0001Z", epochMillis: 1 });
  assert.deepEqual(result.fields.generated, { by: "process:builder", at: "1970-01-01T00:00:00Z" });
  assert.deepEqual(result.fields.parameters, []);
  assert.deepEqual(result.fields.sources, [{ resource: "", id: "", title: "" }]);
  assert.deepEqual(validate(input), { isValid: true, isIndexable: true, errors: [] });
});

test("normalized paths retain case and literal backslashes; CRLF preserves body and lines", () => {
  const result = prepare({ path: "./Notes//Foo_bar.md", markdown: "---\r\ntype: note\r\n---\r\n# Heading\r\nbody" });
  assert.deepEqual(result.identity, { path: "Notes/Foo_bar.md", documentId: "Notes/Foo_bar" });
  assert.equal(result.fields.title, "Foo bar");
  assert.equal(result.body, "# Heading\r\nbody");
  assert.deepEqual(result.sections, [{ id: "Notes/Foo_bar#heading", headingPath: "Heading", text: "body", startLine: 4, endLine: 5 }]);
  const literal = prepare(document("type: note", "", "folder\\note.md"));
  assert.deepEqual(literal.identity, { path: "folder\\note.md", documentId: "folder\\note" });
});

test("degraded results preserve ordered diagnostics and omit invalid facets", () => {
  const input = document(`type: note
title: 1
tags: [ok, 2]
verified: invalid
status: future
stale_after: invalid`, "# Heading\nbody", "./note.md");
  const diagnostics = ["title", "tags[1]", "verified", "status", "stale_after"].map((field) => fieldError(field));
  assert.deepEqual(prepare(input), {
    kind: "accepted", identity: { path: "note.md", documentId: "note" }, conformance: "degraded",
    fields: { type: "note", title: "", tags: ["ok"], sources: [], sourceText: "", verified: [], staleness: { classified: false } },
    body: "# Heading\nbody", bodyStartLine: 9,
    sections: [{ id: "note#heading", headingPath: "Heading", text: "body", startLine: 9, endLine: 10 }],
    diagnostics,
  });
  const fields = prepare(input).fields;
  for (const key of ["status", "trustTier", "staleAfter", "description", "parameters"]) {
    assert.equal(Object.hasOwn(fields, key), false, key);
  }
  assert.deepEqual(validate(input), { isValid: false, isIndexable: true, errors: diagnostics });
});

for (const [label, input, diagnostics] of [
  ["missing frontmatter", { path: "note.md", markdown: "plain" }, [parseError]],
  ["malformed YAML", document("type: ["), [parseError]],
  ["missing type with later field errors", document("title: 1\nstatus: future"), [fieldError("type"), fieldError("title"), fieldError("status")]],
]) {
  test(`fatal ${label} has nonempty ordered diagnostics and is not indexable`, () => {
    assert.deepEqual(prepare(input), { kind: "fatal", diagnostics });
    assert.deepEqual(validate(input), { isValid: false, isIndexable: false, errors: diagnostics });
    if (diagnostics[0].code === "ERR_OKF_PARSE") {
      assert.equal(Object.hasOwn(prepare(input).diagnostics[0], "field"), false);
    }
  });
}

for (const [path, errorPath] of [["", "<input>"], ["../note.md", "<input>"], ["/note.md", "<input>"], ["C:\\note.md", "<input>"], ["folder/", "<input>"], ["./folder//index.md", "folder/index.md"], ["log.md", "log.md"], ["note.txt", "note.txt"]]) {
  test(`invalid identity ${JSON.stringify(path)} is a content failure`, () => {
    const input = document("type: note", "", path);
    const diagnostics = [fieldError("path", errorPath)];
    assert.deepEqual(prepare(input), { kind: "fatal", diagnostics });
    assert.deepEqual(validate(input), { isValid: false, isIndexable: false, errors: diagnostics });
  });
}

test("malformed transport throws through both entry and raw loader", () => {
  for (const input of [undefined, null, 1, "text", {}, { path: 1, markdown: "" }, { path: "../bad", markdown: null }]) {
    assert.throws(() => prepare(input), TypeError);
    assert.throws(() => validate(input), TypeError);
  }
  const valid = { ...document("type: note"), documentId: "note", fallbackTitle: "Note" };
  for (const input of [undefined, null, 1, "text", {}, ...Object.keys(valid).map((key) => ({ ...valid, [key]: 42 }))]) {
    assert.throws(() => native.prepare(input));
    assert.throws(() => native.validate(input));
  }
  const failure = new Error("getter failed");
  const input = { get path() { throw failure; }, markdown: "" };
  assert.throws(() => prepare(input), (error) => error === failure);
  assert.throws(() => validate(input), (error) => error === failure);
});

test("returned nested containers are owned and independent", () => {
  const first = prepare(rich);
  const second = prepare(rich);
  first.fields.tags.push("mutated");
  first.fields.sources[0].usageWindow.from = "changed";
  first.fields.executor.receipt.push("changed");
  first.fields.staleAfter.epochMillis = 42;
  first.sections[0].text = "changed";
  assert.equal(first.fields.staleness.staleAfter.epochMillis, 0);
  assert.deepEqual(second, prepare(rich));
  const invalid = document("type: note\nstatus: future");
  const prepared = prepare(invalid);
  prepared.diagnostics[0].field = "changed";
  assert.deepEqual(validate(invalid).errors, [fieldError("status")]);
});
