import { fromMarkdown } from "mdast-util-from-markdown";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PrepareError,
  prepareOkfDocument,
  validateOkfDocument,
} from "../src/index.js";
import { concept } from "./support/bundle.js";

vi.mock("mdast-util-from-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mdast-util-from-markdown")>();
  return { fromMarkdown: vi.fn(actual.fromMarkdown) };
});

function input(metadata: string, body = "body") {
  return { path: "concept.md", markdown: concept(metadata, body) };
}

beforeEach(() => {
  vi.mocked(fromMarkdown).mockClear();
});

describe("OKF document analysis", () => {
  it("implements the strict, degraded, and fatal truth table", () => {
    expect(validateOkfDocument(input("type: note"))).toEqual({
      isValid: true,
      isIndexable: true,
      errors: [],
    });
    expect(validateOkfDocument(input("type: note\nstatus: future"))).toMatchObject({
      isValid: false,
      isIndexable: true,
      errors: [{ field: "status" }],
    });

    for (const fatal of [
      { path: "../concept.md", markdown: concept("type: note") },
      { path: "concept.md", markdown: "type: note" },
      { path: "concept.md", markdown: "---\ntype: [\n---\n" },
      input("scalar"),
      input("title: missing"),
      input("type: []"),
      input("type: '   '"),
    ]) {
      expect(() => validateOkfDocument(fatal)).not.toThrow();
      expect(validateOkfDocument(fatal)).toMatchObject({
        isValid: false,
        isIndexable: false,
        errors: [expect.any(Object)],
      });
    }

    expect(() => prepareOkfDocument(input("type: []"))).toThrow(
      expect.objectContaining({ code: "ERR_OKF_FIELD", field: "type" }),
    );
  });

  it.each([
    ["title", "type: note\ntitle: {}", ["title"]],
    ["description", "type: note\ndescription: []", ["description"]],
    ["resource", "type: note\nresource: false", ["resource"]],
    ["tags aggregate", "type: note\ntags: nope", ["tags"]],
    ["tags members", "type: note\ntags: [ok, 1, false]", ["tags[1]", "tags[2]"]],
    ["sources aggregate", "type: note\nsources: nope", ["sources"]],
    ["source member", "type: note\nsources: [nope]", ["sources[0]"]],
    ["source children", "type: note\nsources:\n  - id: 1\n    title: false\n    author: 'human:'\n    usage_count: many\n    last_modified: yesterday\n    usage_window: {}", ["sources[0].resource", "sources[0].id", "sources[0].title", "sources[0].author", "sources[0].usage_count", "sources[0].last_modified", "sources[0].usage_window.from", "sources[0].usage_window.to"]],
    ["source window", "type: note\nsources:\n  - resource: x\n    usage_window: nope", ["sources[0].usage_window"]],
    ["usage window", "type: note\nusage_window: {}", ["usage_window.from", "usage_window.to"]],
    ["generated aggregate", "type: note\ngenerated: []", ["generated"]],
    ["generated children", "type: note\ngenerated: {by: bad actor, at: today}", ["generated.by", "generated.at"]],
    ["verified aggregate", "type: note\nverified: nope", ["verified"]],
    ["verified member", "type: note\nverified: [nope]", ["verified[0]"]],
    ["verified children", "type: note\nverified: [{}]", ["verified[0].by", "verified[0].at"]],
    ["stale after", "type: note\nstale_after: yesterday", ["stale_after"]],
    ["runtime", "type: note\nruntime: 1", ["runtime"]],
    ["parameters aggregate", "type: note\nparameters: nope", ["parameters"]],
    ["parameter member", "type: note\nparameters: [nope]", ["parameters[0]"]],
    ["parameter children", "type: note\nparameters: [{}]", ["parameters[0].name", "parameters[0].type", "parameters[0].required"]],
    ["computation", "type: note\ncomputation: []", ["computation"]],
    ["executor aggregate", "type: note\nexecutor: nope", ["executor"]],
    ["executor children", "type: note\nexecutor: {}", ["executor.resource", "executor.receipt"]],
    ["executor receipt member", "type: note\nexecutor:\n  resource: x\n  receipt: [ok, 1]", ["executor.receipt[1]"]],
    ["attester aggregate", "type: note\nattester: nope", ["attester"]],
    ["attester child", "type: note\nattester: {}", ["attester.resource"]],
  ])("preserves %s projector diagnostics", (_name, metadata, expectedFields) => {
    expect(validateOkfDocument(input(metadata)).errors.map((error) => error.field))
      .toEqual(expectedFields);
  });

  it.each([
    ["numeric", "1: value"],
    ["boolean", "true: value"],
    ["null", "null: value"],
    ["sequence", "? [one, two]\n: value"],
    ["mapping", "? {one: two}\n: value"],
    ["nested", "extension: {1: value}"],
    ["alias to number", "number: &number 1\n? *number\n: value"],
    ["alias to sequence", "sequence: &sequence [one, two]\n? *sequence\n: value"],
    ["alias to mapping", "mapping: &mapping {key: value}\n? *mapping\n: value"],
  ])("rejects %s YAML mapping keys", (_name, metadata) => {
    const source = input(`type: note\n${metadata}`);
    expect(validateOkfDocument(source)).toEqual({
      isValid: false,
      isIndexable: false,
      errors: [{
        code: "ERR_OKF_PARSE",
        path: "concept.md",
        message: "Cannot parse OKF concept: concept.md",
      }],
    });
    expect(() => prepareOkfDocument(source)).toThrow(
      expect.objectContaining({
        code: "ERR_OKF_PARSE",
        path: "concept.md",
      }),
    );
  });

  it.each([
    ["plain", "key: value", "key", "value"],
    ["quoted", '"1": quoted', "1", "quoted"],
    ["alias to string", "anchor: &key aliased\n? *key\n: value", "aliased", "value"],
  ])("accepts %s YAML mapping keys", (_name, metadata, key, value) => {
    const prepared = prepareOkfDocument(input(`type: note\n${metadata}`));
    expect(prepared.conformance).toBe("strict");
    if (prepared.conformance === "strict") {
      expect(prepared.document.extensions).toMatchObject({ [key]: value });
    }
  });

  it("orders diagnostics by projector order rather than YAML order", () => {
    const result = validateOkfDocument(input(`
      attester: {}
      status: future
      sources:
        - {}
        - resource: ok
          author: bad actor
      type: ' '
      tags: [ok, 2]
      verified:
        - {}
        - nope
      executor: {}
    `));

    expect(result.errors.map((error) => error.field)).toEqual([
      "type",
      "tags[1]",
      "sources[0].resource",
      "sources[1].author",
      "verified[0].by",
      "verified[0].at",
      "verified[1]",
      "status",
      "executor.resource",
      "executor.receipt",
      "attester.resource",
    ]);
  });

  it("preserves official field semantics and strict document detachment", () => {
    const source = input(`
      type: Attested Computation
      title: ''
      description: ''
      resource: ../missing
      tags: ['', duplicate, duplicate]
      sources:
        - resource: ../source
          author: producer/version
          usage_count: -1.5
          last_modified: 2026-08-24T10:00:00Z
          usage_window:
            from: 2027-08-24T10:00:00Z
            to: 2026-08-24T10:00:00Z
      usage_window:
        from: 2027-08-24T10:00:00+01:00
        to: 2026-08-24T10:00:00Z
      generated:
        by: process:builder
        at: 2026-08-24T10:00:00.1239Z
      verified:
        by: human:alice
        at: 2026-08-24T10:00:00Z
      status: stable
      stale_after: 2026-08-24T10:00:00Z
      runtime: ''
      parameters:
        - name: ''
          type: ''
          required: false
      computation: ../missing.ts
      executor:
        resource: ../executor
        receipt: []
      attester:
        resource: ../attester
      extension: {nested: true}
    `, "[broken](../missing.md)");

    const first = prepareOkfDocument(source);
    const second = prepareOkfDocument(source);
    expect(first.conformance).toBe("strict");
    expect(second.conformance).toBe("strict");
    expect(Object.hasOwn(first, "kind")).toBe(false);
    if (first.conformance !== "strict" || second.conformance !== "strict") {
      expect.unreachable();
    }
    expect(first.document).toEqual({
      id: "concept",
      type: "Attested Computation",
      title: "",
      description: "",
      resource: "../missing",
      tags: ["", "duplicate", "duplicate"],
      sources: [{
        resource: "../source",
        author: "producer/version",
        usageCount: -1.5,
        lastModified: "2026-08-24T10:00:00Z",
        usageWindow: {
          from: "2027-08-24T10:00:00Z",
          to: "2026-08-24T10:00:00Z",
        },
      }],
      usageWindow: {
        from: "2027-08-24T10:00:00+01:00",
        to: "2026-08-24T10:00:00Z",
      },
      generated: {
        by: "process:builder",
        at: "2026-08-24T10:00:00.1239Z",
      },
      verified: [{ by: "human:alice", at: "2026-08-24T10:00:00Z" }],
      status: "stable",
      staleAfter: "2026-08-24T10:00:00Z",
      runtime: "",
      parameters: [{ name: "", type: "", required: false }],
      computation: "../missing.ts",
      executor: { resource: "../executor", receipt: [] },
      attester: { resource: "../attester" },
      body: "[broken](../missing.md)",
      extensions: { extension: { nested: true } },
    });
    expect(first.document).not.toBe(second.document);
    expect(first.document.tags).not.toBe(second.document.tags);
    expect(first.document.sources[0]).not.toBe(second.document.sources[0]);
    expect(first.document.sources[0]!.usageWindow)
      .not.toBe(second.document.sources[0]!.usageWindow);
    expect(first.document.usageWindow).not.toBe(second.document.usageWindow);
    expect(first.document.generated).not.toBe(second.document.generated);
    expect(first.document.verified[0]).not.toBe(second.document.verified[0]);
    expect(first.document.parameters![0]).not.toBe(second.document.parameters![0]);
    expect(first.document.executor!.receipt).not.toBe(second.document.executor!.receipt);
    expect(first.document.attester).not.toBe(second.document.attester);
    expect(first.document.extensions.extension)
      .not.toBe(second.document.extensions.extension);
    expect(first.sections).not.toBe(second.sections);
    expect(first.metadata.tags).not.toBe(second.metadata.tags);
  });

  it("returns detached diagnostics and omits document from degraded values", () => {
    const source = input("type: note\nstatus: future");
    const validation = validateOkfDocument(source);
    const first = prepareOkfDocument(source);
    const second = prepareOkfDocument(source);

    expect(first.conformance).toBe("degraded");
    expect(Object.hasOwn(first, "kind")).toBe(false);
    expect(Object.hasOwn(first, "document")).toBe(false);
    if (first.conformance !== "degraded" || second.conformance !== "degraded") {
      expect.unreachable();
    }
    const originalValues = {
      isValid: validation.isValid,
      isIndexable: validation.isIndexable,
      errors: validation.errors.map((error) => ({ ...error })),
    };
    const mutableErrors = validation.errors as unknown as Array<{
      field?: string;
      [key: string]: unknown;
    }>;
    mutableErrors[0]!.field = "mutated";
    mutableErrors.push({ ...mutableErrors[0]!, field: "extra" });
    const revalidated = validateOkfDocument(source);

    expect(revalidated).toMatchObject({
      isValid: originalValues.isValid,
      isIndexable: originalValues.isIndexable,
    });
    expect(revalidated.errors).toEqual(originalValues.errors);
    expect(revalidated.errors).not.toBe(validation.errors);
    expect(revalidated.errors[0]).not.toBe(validation.errors[0]);
    expect(first.diagnostics).not.toBe(second.diagnostics);
    expect(first.diagnostics[0]).not.toBe(second.diagnostics[0]);
    expect(first.diagnostics).not.toBe(validation.errors);
    expect(first.diagnostics[0]).not.toBe(validation.errors[0]);
  });

  it("requires runtime only for the exact Attested Computation type", () => {
    expect(validateOkfDocument(input("type: Attested Computation")).errors)
      .toEqual([expect.objectContaining({ field: "runtime" })]);
    expect(validateOkfDocument(input("type: Attested Computation\nruntime: node")).isValid)
      .toBe(true);
    expect(validateOkfDocument(input("type: attested computation")).isValid)
      .toBe(true);
  });

  it("keeps Markdown failure fatal while type has fatal precedence", () => {
    vi.mocked(fromMarkdown)
      .mockImplementationOnce(() => { throw new Error("injected parser failure"); })
      .mockImplementationOnce(() => { throw new Error("injected parser failure"); })
      .mockImplementationOnce(() => { throw new Error("injected parser failure"); });

    const parseOnly = input("type: note");
    expect(validateOkfDocument(parseOnly)).toEqual({
      isValid: false,
      isIndexable: false,
      errors: [{
        code: "ERR_OKF_PARSE",
        path: "concept.md",
        message: "Cannot parse OKF concept: concept.md",
      }],
    });
    const competingFatal = input("type: ' '");
    expect(validateOkfDocument(competingFatal).errors.map((error) => error.field))
      .toEqual(["type", undefined]);
    expect(() => prepareOkfDocument(competingFatal)).toThrow(
      expect.objectContaining({ code: "ERR_OKF_FIELD", field: "type" }),
    );
  });

  it("throws a fresh PrepareError for each expected fatal preparation", () => {
    const fatal = input("title: absent");
    let first: unknown;
    let second: unknown;
    try { prepareOkfDocument(fatal); } catch (error) { first = error; }
    try { prepareOkfDocument(fatal); } catch (error) { second = error; }
    expect(first).toBeInstanceOf(PrepareError);
    expect(second).toBeInstanceOf(PrepareError);
    expect(first).not.toBe(second);
  });
});
