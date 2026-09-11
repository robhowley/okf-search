import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { NativeOkfSearch } from "../native.cjs";
import { wrapNative } from "../src/create-okf-search.js";
import { throwNativeError } from "../src/errors.js";
import { createOkfSearch, OkfError, openOkf, validateOkfDocument } from "../src/index.js";

const markdown = "---\ntype: note\n---\nNative needle 😀 �";
function failure(call: () => unknown): any {
  try { call(); } catch (error) { return error; }
  throw new Error("Expected failure");
}
function checkError(error: any, code: string, path: string, field?: string) {
  expect(error).toBeInstanceOf(OkfError);
  expect(error).toMatchObject({ code, path });
  expect(Object.hasOwn(error, "field")).toBe(field !== undefined);
  if (field !== undefined) expect(error.field).toBe(field);
  expect(Object.hasOwn(error, "cause")).toBe(false);
}

describe("native raw preparation boundary", () => {
  it("copies membership, then snapshots path and markdown once in caller order", () => {
    const calls: string[] = [];
    let firstPath = "z.md";
    let firstMarkdown = markdown;
    const inputs = [
      { get path() { calls.push("0.path"); inputs[1] = { path: "wrong.md", markdown: "bad" }; return firstPath; },
        get markdown() { calls.push("0.markdown"); return firstMarkdown; } },
      { get path() { calls.push("1.path"); firstPath = "changed.md"; firstMarkdown = "bad"; return "a.md"; },
        get markdown() { calls.push("1.markdown"); return markdown; } },
    ];
    const index = createOkfSearch(inputs);
    expect(calls).toEqual(["0.path", "0.markdown", "1.path", "1.markdown"]);
    expect(index.search("needle").map(hit => hit.path).sort()).toEqual(["a.md", "z.md"]);
  });

  it.each([
    failure(() => NativeOkfSearch.fromRaw([{ path: "../invalid.md", markdown }])),
    ...["ERR_OKF_INDEX_UNUSABLE", "ERR_OKF_FIELD", "ERR_OKF_PARSE", "ERR_OKF_READ", "ERR_OKF_NATIVE", "ERR_OKF_INVALID_SEARCH_OPTIONS", "ERR_OKF_UNSUPPORTED"].map(code =>
      Object.assign(new Error(`[${code}] caller sentinel`), { code, path: "caller", custom: 42 })),
    Object.assign(new TypeError("caller sentinel"), { code: "ERR_OKF_FIELD", path: "caller", custom: 42 }),
    { custom: 42, toString() { throw new Error("must not stringify caller throws"); } },
    Object.defineProperty(new Error(), "message", { get() { throw new Error("must not read caller message getters"); } }),
    "primitive sentinel", 17, true, 1n, Symbol("sentinel"), null, undefined,
  ])("preserves caller throws exactly without poisoning: %#", sentinel => {
    const index = createOkfSearch([]);
    for (const field of ["path", "markdown"] as const) {
      const input = { path: "a.md", markdown };
      Object.defineProperty(input, field, { get() { throw sentinel; } });
      expect(failure(() => createOkfSearch([input]))).toBe(sentinel);
      expect(failure(() => index.ingest(input))).toBe(sentinel);
      expect(index.ingest({ path: "recovery.md", markdown }).conformance).toBe("strict");
      expect(index.remove("recovery.md")).toBe(true);
      expect(createOkfSearch([{ path: "valid.md", markdown }]).search("needle")).toHaveLength(1);
    }
    const inputs = [{ path: "a.md", markdown }];
    inputs[Symbol.iterator] = function* () { yield inputs[0]!; throw sentinel; };
    expect(failure(() => createOkfSearch(inputs))).toBe(sentinel);
    expect(createOkfSearch([{ path: "valid.md", markdown }]).search("needle")).toHaveLength(1);
    expect(index.indexStats().logical.documents.total).toBe(0);
    expect(index.ingest({ path: "a.md", markdown }).conformance).toBe("strict");
  });

  it("translates a native search validation error without poisoning the engine", () => {
    const native = NativeOkfSearch.fromRaw([{ path: "a.md", markdown }]);
    const error = failure(() => native.search("needle", { match: "invalid" }));
    expect(error.message).toMatch(/^\[ERR_OKF_INVALID_SEARCH_OPTIONS\]/);
    const projected = failure(() => throwNativeError(error, "<index>"));
    expect(projected).toBeInstanceOf(TypeError);
    expect(projected.message).not.toContain("[ERR_OKF_");
    expect(native.search("needle")).toHaveLength(1);
  });

  it("reentrant inventory getters complete without a held engine lock", () => {
    const child = spawnSync(process.execPath, ["-e", `
      const assert = require("node:assert/strict");
      const { NativeOkfSearch } = require(${JSON.stringify(join(__dirname, "../native.cjs"))});
      const index = NativeOkfSearch.fromRaw([]);
      const calls = [];
      index.ingestRaw({
        get path() { calls.push("path"); assert.deepEqual(index.listTypes(), []); return "a.md"; },
        get markdown() { calls.push("markdown"); assert.equal(index.indexStats().logical.documents.total, 0); return ${JSON.stringify(markdown)}; },
      });
      assert.deepEqual(calls, ["path", "markdown"]);
    `], { timeout: 2_000, encoding: "utf8" });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
  });

  it.each(["\ud800", "\udfff"])("rejects lone surrogate %j without replacement or mutation", async surrogate => {
    const index = createOkfSearch([{ path: "a.md", markdown }]);
    checkError(failure(() => createOkfSearch([{ path: `${surrogate}.md`, markdown }])), "ERR_OKF_FIELD", "<input>", "path");
    checkError(failure(() => index.ingest({ path: `${surrogate}.md`, markdown })), "ERR_OKF_FIELD", "<input>", "path");
    checkError(failure(() => index.remove(`${surrogate}.md`)), "ERR_OKF_FIELD", "<input>", "path");
    checkError(failure(() => index.ingest({ path: "./a.md", markdown: markdown + surrogate })), "ERR_OKF_PARSE", "a.md");
    checkError(failure(() => createOkfSearch([{ path: "./a.md", markdown: markdown + surrogate }])), "ERR_OKF_PARSE", "a.md");
    checkError(await openOkf(surrogate).catch(error => error), "ERR_OKF_FIELD", "<input>", "path");
    for (const [path, content, code, errorPath, field] of [
      [`${surrogate}.md`, markdown, "ERR_OKF_FIELD", "<input>", "path"],
      ["./a.md", markdown + surrogate, "ERR_OKF_PARSE", "a.md", undefined],
    ] as const) {
      const validation = validateOkfDocument({ path, markdown: content });
      expect(validation).toMatchObject({ isValid: false, isIndexable: false, errors: [{ code, path: errorPath }] });
      expect(Object.hasOwn(validation.errors[0]!, "field")).toBe(field !== undefined);
      expect(Object.hasOwn(validation.errors[0]!, "cause")).toBe(false);
    }
    checkError(failure(() => createOkfSearch([
      { path: "a.md", markdown: surrogate }, { path: "./a.md", markdown },
    ])), "ERR_OKF_FIELD", "a.md", "path");
    checkError(failure(() => createOkfSearch([
      { path: "a.md", markdown: surrogate }, { path: "../bad.md", markdown },
    ])), "ERR_OKF_FIELD", "<input>", "path");
    expect(index.search("needle")).toHaveLength(1);
    expect(index.indexStats().logical.documents.total).toBe(1);
    expect(index.ingest({ path: "😀�.md", markdown }).conformance).toBe("strict");
  });

  it("snapshots the entire batch before identity checks and prepares in normalized order", () => {
    const calls: string[] = [];
    checkError(failure(() => createOkfSearch([
      { get path() { calls.push("0.path"); return "index.md"; }, get markdown() { calls.push("0.markdown"); return "\ud800"; } },
      { get path() { calls.push("1.path"); return "\ud800.md"; }, get markdown() { calls.push("1.markdown"); return markdown; } },
    ])), "ERR_OKF_FIELD", "index.md", "path");
    expect(calls).toEqual(["0.path", "0.markdown", "1.path", "1.markdown"]);
    checkError(failure(() => createOkfSearch([
      { path: "z.md", markdown: "\ud800" }, { path: "./a.md", markdown: "bad" },
    ])), "ERR_OKF_PARSE", "a.md");
  });

  it("native poison precedes getters and path validation, then the facade caches it", () => {
    const root = join(__dirname, "..");
    const build = spawnSync("cargo", ["build", "--locked", "--features", "test-fixtures", "--quiet"], { cwd: root, encoding: "utf8" });
    expect(build.error).toBeUndefined();
    expect(build.status, build.stderr).toBe(0);
    const temporary = mkdtempSync(join(tmpdir(), "okf-poison-fixture-"));
    try {
      const library = process.platform === "darwin" ? "libokf_search_native.dylib" : process.platform === "win32" ? "okf_search_native.dll" : "libokf_search_native.so";
      const addon = join(temporary, "fixture.node");
      copyFileSync(join(root, "target/debug", library), addon);
      const { createPoisonedSearchFixture } = createRequire(import.meta.url)(addon);
      const native: NativeOkfSearch = createPoisonedSearchFixture();
      // A genuine native error from a different handle is still a caller throw.
      const sentinel = failure(() => native.ingestRaw({ path: "a.md", markdown }));
      expect(sentinel.message).toMatch(/^\[ERR_OKF_INDEX_UNUSABLE\]/);
      Object.defineProperty(sentinel, "path", { get() { throw new Error("error path getter touched"); } });
      const healthyNative = NativeOkfSearch.fromRaw([]);
      const healthy = wrapNative(healthyNative);
      for (const field of ["path", "markdown"] as const) {
        const throwing = { path: "a.md", markdown };
        Object.defineProperty(throwing, field, { get() { throw sentinel; } });
        expect(failure(() => createOkfSearch([throwing]))).toBe(sentinel);
        expect(failure(() => healthy.ingest(throwing))).toBe(sentinel);
        expect(failure(() => NativeOkfSearch.fromRaw([throwing]))).toBe(sentinel);
        expect(failure(() => healthyNative.ingestRaw(throwing))).toBe(sentinel);
        expect(healthy.ingest({ path: "recovery.md", markdown }).conformance).toBe("strict");
        expect(healthy.remove("recovery.md")).toBe(true);
      }
      const iterable = [{ path: "a.md", markdown }];
      iterable[Symbol.iterator] = function* () { yield iterable[0]!; throw sentinel; };
      expect(failure(() => createOkfSearch(iterable))).toBe(sentinel);
      expect(healthy.ingest({ path: "recovery.md", markdown }).conformance).toBe("strict");
      expect(healthy.search("needle")).toHaveLength(1);
      const calls: string[] = [];
      const input = {
        get path(): string { calls.push("path"); throw new Error("path getter touched"); },
        get markdown(): string { calls.push("markdown"); throw new Error("markdown getter touched"); },
      };
      expect(failure(() => native.ingestRaw(input)).message).toMatch(/^\[ERR_OKF_INDEX_UNUSABLE\]/);
      expect(calls).toEqual([]);
      expect(failure(() => native.removePath("\ud800")).message).toMatch(/^\[ERR_OKF_INDEX_UNUSABLE\]/);
      for (const method of ["search", "indexStats", "listTypes", "listDegradedDocuments"] as const) {
        expect(failure(() => native[method]("needle")).message).toMatch(/^\[ERR_OKF_INDEX_UNUSABLE\]/);
        const facade = wrapNative(native);
        const projected = failure(() => facade[method]("needle"));
        checkError(projected, "ERR_OKF_INDEX_UNUSABLE", "<index>");
        expect(failure(() => facade.listTypes())).toBe(projected);
      }
      const index = wrapNative(native);
      const first = failure(() => index.ingest(input));
      checkError(first, "ERR_OKF_INDEX_UNUSABLE", "<index>");
      expect(failure(() => index.ingest(input))).toBe(first);
      expect(failure(() => index.remove("\ud800"))).toBe(first);
      expect(failure(() => index.listTypes())).toBe(first);
      expect(calls).toEqual([]);
      expect("createPoisonedSearchFixture" in createRequire(import.meta.url)(join(root, "native.cjs"))).toBe(false);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }, 120_000);

  it("omits absent optionals and projects supported tagged values and arbitrary string keys", () => {
    const result = createOkfSearch([]).ingest({
      path: "minimal.md",
      markdown: '---\ntype: note\ncustom: !tag {value: !!str 12}\n"nul\\0key": nested\n---\nbody',
    });
    expect(result.conformance).toBe("strict");
    if (result.conformance !== "strict") throw new Error("Expected strict document");
    expect(Object.keys(result.document).sort()).toEqual(["id", "type", "title", "tags", "sources", "verified", "status", "body", "extensions"].sort());
    expect(result.document.extensions).toEqual({ custom: { value: "12" }, ["nul\0key"]: "nested" });
  });

  it("returns the complete strict document with detached YAML extensions", () => {
    const index = createOkfSearch([]);
    const body = "# Original\r\nBody 😀\n";
    const content = `---
type: tool
title: Full
description: Description
resource: https://example.test
tags: [one]
status: stable
stale_after: '2027-01-01T00:00:00Z'
usage_window: {from: '2025-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z'}
generated: {by: process:agent, at: '2025-01-01T00:00:00Z'}
verified: [{by: human:reviewer, at: '2025-02-01T00:00:00Z'}]
sources:
  - resource: source
    id: source-id
    title: Source
    author: human:author
    usage_count: 3
    last_modified: '2025-01-01T00:00:00Z'
    usage_window: {from: '2025-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z'}
runtime: node
parameters: [{name: query, type: string, required: true}]
computation: run
executor: {resource: executor, receipt: [receipt]}
attester: {resource: attester}
id: yaml-id
custom: {nested: [null, true, 42, -0.0, .inf, -.inf, .nan], __proto__: {safe: true}}
__proto__: {own: yes}
---
${body}`;
    const result = index.ingest({ path: "./full.md", markdown: content });
    expect(result.conformance).toBe("strict");
    if (result.conformance !== "strict") throw new Error(JSON.stringify(result));
    const document = result.document;
    expect(document).toMatchObject({
      id: "full", type: "tool", title: "Full", description: "Description", resource: "https://example.test",
      tags: ["one"], status: "stable", staleAfter: "2027-01-01T00:00:00Z", body,
      usageWindow: { from: "2025-01-01T00:00:00Z", to: "2026-01-01T00:00:00Z" },
      generated: { by: "process:agent", at: "2025-01-01T00:00:00Z" }, verified: [{ by: "human:reviewer", at: "2025-02-01T00:00:00Z" }],
      sources: [{ resource: "source", id: "source-id", title: "Source", author: "human:author", usageCount: 3, lastModified: "2025-01-01T00:00:00Z", usageWindow: { from: "2025-01-01T00:00:00Z", to: "2026-01-01T00:00:00Z" } }],
      runtime: "node", parameters: [{ name: "query", type: "string", required: true }], computation: "run",
      executor: { resource: "executor", receipt: ["receipt"] }, attester: { resource: "attester" },
    });
    expect(Object.keys(document).sort()).toEqual(["id", "type", "title", "description", "resource", "tags", "status", "staleAfter", "body", "usageWindow", "generated", "verified", "sources", "runtime", "parameters", "computation", "executor", "attester", "extensions"].sort());
    const extensions = document.extensions as any;
    expect(extensions.id).toBe("yaml-id");
    expect(Object.hasOwn(extensions, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(extensions)).toBe(Object.prototype);
    expect(extensions.custom.nested.slice(0, 3)).toEqual([null, true, 42]);
    expect(Object.is(extensions.custom.nested[3], -0)).toBe(true);
    expect(extensions.custom.nested.slice(4)).toEqual([Infinity, -Infinity, NaN]);
    expect(Object.hasOwn(extensions.custom, "__proto__")).toBe(true);
    extensions.custom.nested[0] = "changed";
    document.tags[0] = "changed";
    const again = index.ingest({ path: "full.md", markdown: content });
    expect(again.conformance).toBe("strict");
    if (again.conformance === "strict") expect((again.document.extensions as any).custom.nested[0]).toBeNull();
    expect(index.search("Body", { where: { tagsAny: ["one"] } })).toHaveLength(1);
  });
});
