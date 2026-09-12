import { fromMarkdown } from "mdast-util-from-markdown";

import { PrepareError } from "./errors.js";
import { normalizeOkfDocumentIdentity } from "./identity.js";
import { isOkfStatus } from "./vocabulary.js";
import { parseOkfYaml } from "./yaml.js";

import type { RootContent } from "mdast";
import type { Node, Position } from "unist";

import type {
  DegradedPreparedOkfFacets,
  NonEmptyDiagnostics,
  NonEmptyPreparedOkfSections,
  OkfDiagnostic,
  OkfDocument,
  OkfDocumentIdentity,
  OkfDocumentInput,
  OkfSource,
  OkfStatus,
  OkfTimeWindow,
  OkfTrustTier,
  OkfValidationResult,
  OkfVerification,
  PreparedOkfDocument,
  PreparedOkfMetadata,
  PreparedOkfStalenessFacet,
  StrictPreparedOkfFacets,
} from "./types.js";

const MAX_SECTION_WORDS = 800;
const TARGET_CHUNK_WORDS = 500;

const STANDARD_KEYS = new Set([
  "type", "title", "description", "resource", "tags", "sources",
  "usage_window", "generated", "verified", "status", "stale_after",
  "runtime", "parameters", "computation", "executor", "attester",
]);

type PositionedBlock = RootContent & { position: Position };

interface Section {
  headingPath: string;
  slug: string;
  headingLine?: number;
  blocks: PositionedBlock[];
}

interface Chunk {
  text: string;
  startLine: number;
  endLine: number;
}

interface ProjectedFields {
  readonly type?: string;
  readonly title: string;
  readonly description?: string;
  readonly resource?: string;
  readonly tags: string[];
  readonly sources: OkfSource[];
  readonly sourceText: string;
  readonly usageWindow?: OkfTimeWindow;
  readonly generated?: NonNullable<OkfDocument["generated"]>;
  readonly verified: OkfVerification[];
  readonly trustTier?: OkfTrustTier;
  readonly status?: OkfStatus;
  readonly staleness: PreparedOkfStalenessFacet;
  readonly runtime?: string;
  readonly parameters?: NonNullable<OkfDocument["parameters"]>;
  readonly computation?: string;
  readonly executor?: NonNullable<OkfDocument["executor"]>;
  readonly attester?: NonNullable<OkfDocument["attester"]>;
}

interface DocumentSnapshot {
  readonly path: string;
  readonly markdown: string;
}

type DocumentAnalysis =
  | {
      readonly kind: "fatal";
      readonly diagnostics: NonEmptyDiagnostics;
      readonly fatalDiagnostic: OkfDiagnostic;
    }
  | {
      readonly kind: "accepted";
      readonly prepared: PreparedOkfDocument;
    };

export function validateOkfDocument(
  input: OkfDocumentInput,
): OkfValidationResult {
  const analysis = analyzeDocument(snapshotInput(input));

  if (analysis.kind === "fatal") {
    return {
      isValid: false,
      isIndexable: false,
      errors: nonEmptyDiagnostics(copyDiagnostics(analysis.diagnostics)),
    };
  }

  if (analysis.prepared.conformance === "strict") {
    return {
      isValid: true,
      isIndexable: true,
      errors: [],
    };
  }

  return {
    isValid: false,
    isIndexable: true,
    errors: nonEmptyDiagnostics(copyDiagnostics(analysis.prepared.diagnostics)),
  };
}

export function prepareOkfDocument(
  input: OkfDocumentInput,
): PreparedOkfDocument {
  return acceptedAnalysis(analyzeDocument(snapshotInput(input)));
}

export function prepareOkfDocuments(
  inputs: readonly OkfDocumentInput[],
): readonly PreparedOkfDocument[] {
  const snapshots = [...inputs].map(snapshotInput);
  const normalized = snapshots.map((input) => ({
    input,
    identity: normalizeOkfDocumentIdentity(input.path),
  }));

  normalized.sort((left, right) =>
    left.identity.path < right.identity.path
      ? -1
      : left.identity.path > right.identity.path
        ? 1
        : 0
  );

  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1]!;
    const current = normalized[index]!;
    if (current.identity.documentId === previous.identity.documentId) {
      throw new PrepareError("ERR_OKF_FIELD", current.identity.path, {
        field: "path",
      });
    }
  }

  return normalized.map(({ input, identity }) =>
    acceptedAnalysis(analyzeDocument(input, identity))
  );
}

function snapshotInput(input: OkfDocumentInput): DocumentSnapshot {
  return {
    path: input.path,
    markdown: input.markdown,
  };
}

function acceptedAnalysis(analysis: DocumentAnalysis): PreparedOkfDocument {
  if (analysis.kind === "fatal") {
    const diagnostic = analysis.fatalDiagnostic;
    throw new PrepareError(diagnostic.code, diagnostic.path, {
      ...(diagnostic.field ? { field: diagnostic.field } : {}),
    });
  }

  return analysis.prepared;
}

function analyzeDocument(
  input: DocumentSnapshot,
  normalizedIdentity?: OkfDocumentIdentity,
): DocumentAnalysis {
  let identity: OkfDocumentIdentity;

  try {
    identity = normalizedIdentity ?? normalizeOkfDocumentIdentity(input.path);
  } catch (error) {
    return expectedFatal(error);
  }

  const { path, documentId } = identity;
  let frontmatter: ReturnType<typeof splitFrontmatter>;

  try {
    frontmatter = splitFrontmatter(input.markdown, path);
  } catch (error) {
    return expectedFatal(error);
  }

  let parsed: unknown;

  try {
    parsed = parseOkfYaml(frontmatter.yaml);
  } catch {
    return fatalAnalysis([diagnostic("ERR_OKF_PARSE", path)]);
  }

  if (!isRecord(parsed)) {
    return fatalAnalysis([diagnostic("ERR_OKF_PARSE", path)]);
  }

  const diagnostics: OkfDiagnostic[] = [];
  const fields = projectFields(parsed, documentId, path, diagnostics);
  const typeDiagnostic = diagnostics.find((item) => item.field === "type");
  let conceptSections: Section[] | undefined;
  let markdownDiagnostic: OkfDiagnostic | undefined;

  try {
    conceptSections = sections(
      frontmatter.body,
      fields.title,
      frontmatter.bodyStartLine,
    );
  } catch {
    markdownDiagnostic = diagnostic("ERR_OKF_PARSE", path);
    diagnostics.push(markdownDiagnostic);
  }

  if (typeDiagnostic || markdownDiagnostic || !fields.type || !conceptSections) {
    return fatalAnalysis(
      diagnostics,
      typeDiagnostic ?? markdownDiagnostic,
    );
  }

  const type = fields.type;
  const preparedSections = buildPreparedSections(
    documentId,
    conceptSections,
    frontmatter.body,
    frontmatter.bodyStartLine,
  );
  const metadata = buildMetadata(fields);
  const preparedIdentity = { path, documentId };

  if (diagnostics.length === 0) {
    if (
      fields.status === undefined
      || fields.trustTier === undefined
      || !fields.staleness.classified
    ) {
      throw new Error("Strict OKF analysis requires classified facets");
    }

    const facets: StrictPreparedOkfFacets = {
      status: { classified: true, value: fields.status },
      trust: { classified: true, value: fields.trustTier },
      staleness: { ...fields.staleness },
    };
    const document = buildStrictDocument(
      parsed,
      documentId,
      type,
      frontmatter,
      fields,
      facets,
    );

    return {
      kind: "accepted",
      prepared: {
        conformance: "strict",
        identity: preparedIdentity,
        type,
        metadata,
        facets,
        sections: preparedSections,
        diagnostics: [],
        document,
      },
    };
  }

  const facets: DegradedPreparedOkfFacets = {
    status: fields.status === undefined
      ? { classified: false }
      : { classified: true, value: fields.status },
    trust: fields.trustTier === undefined
      ? { classified: false }
      : { classified: true, value: fields.trustTier },
    staleness: { ...fields.staleness },
  };

  return {
    kind: "accepted",
    prepared: {
      conformance: "degraded",
      identity: preparedIdentity,
      type,
      metadata,
      facets,
      sections: preparedSections,
      diagnostics: nonEmptyDiagnostics(diagnostics),
    },
  };
}

function buildMetadata(fields: ProjectedFields): PreparedOkfMetadata {
  return {
    title: fields.title,
    ...(fields.description === undefined ? {} : { description: fields.description }),
    ...(fields.resource === undefined ? {} : { resource: fields.resource }),
    tags: [...fields.tags],
    sourceText: fields.sourceText,
  };
}

function expectedFatal(error: unknown): DocumentAnalysis {
  if (
    !(error instanceof PrepareError) ||
    error.code === "ERR_OKF_READ"
  ) {
    throw error;
  }

  return fatalAnalysis([{
    code: error.code,
    path: error.path,
    ...(error.field ? { field: error.field } : {}),
    message: error.message,
  }]);
}

function fatalAnalysis(
  diagnostics: OkfDiagnostic[],
  fatalDiagnostic = diagnostics[0],
): Extract<DocumentAnalysis, { readonly kind: "fatal" }> {
  if (!fatalDiagnostic) {
    throw new Error("Fatal OKF analysis requires a diagnostic");
  }

  return {
    kind: "fatal",
    diagnostics: nonEmptyDiagnostics(diagnostics),
    fatalDiagnostic,
  };
}

function diagnostic(
  code: OkfDiagnostic["code"],
  path: string,
  field?: string,
): OkfDiagnostic {
  const error = new PrepareError(code, path, field ? { field } : {});
  return {
    code,
    path,
    ...(field ? { field } : {}),
    message: error.message,
  };
}

function copyDiagnostics(
  diagnostics: readonly OkfDiagnostic[],
): OkfDiagnostic[] {
  return diagnostics.map((item) => ({ ...item }));
}

function nonEmptyDiagnostics(
  diagnostics: OkfDiagnostic[],
): NonEmptyDiagnostics {
  const first = diagnostics[0];
  if (!first) {
    throw new Error("Expected at least one OKF diagnostic");
  }
  return [first, ...diagnostics.slice(1)];
}

function projectFields(
  data: Record<string, unknown>,
  documentId: string,
  path: string,
  diagnostics: OkfDiagnostic[],
): ProjectedFields {
  const invalid = (field: string): void => {
    diagnostics.push(diagnostic("ERR_OKF_FIELD", path, field));
  };
  const present = (key: string): boolean => Object.hasOwn(data, key);

  const type = typeof data.type === "string" && data.type.trim()
    ? data.type
    : undefined;
  if (!type) invalid("type");

  const title = !present("title")
    ? titleFromId(documentId)
    : typeof data.title === "string"
      ? data.title
      : (invalid("title"), "");
  const description = stringField(data, "description", invalid);
  const resource = stringField(data, "resource", invalid);
  const tags = stringArray(data, "tags", invalid);
  const sourceProjection = projectSources(data, invalid);
  const usageWindow = optionalTimeWindow(data, "usage_window", invalid);
  const generated = projectGenerated(data, invalid);
  const verification = projectVerification(data, invalid);

  const status = !present("status")
    ? "stable"
    : isOkfStatus(data.status)
      ? data.status
      : (invalid("status"), undefined);

  let staleness: PreparedOkfStalenessFacet;
  if (!present("stale_after")) {
    staleness = { classified: true };
  } else {
    const staleAfterEpoch = typeof data.stale_after === "string"
      ? parseTimestamp(data.stale_after)
      : undefined;
    if (staleAfterEpoch === undefined) {
      invalid("stale_after");
      staleness = { classified: false };
    } else {
      staleness = {
        classified: true,
        staleAfter: data.stale_after as string,
        staleAfterEpoch,
      };
    }
  }

  const runtime = stringField(data, "runtime", invalid);
  if (type === "Attested Computation" && !present("runtime")) {
    invalid("runtime");
  }

  const parameters = projectParameters(data, invalid);
  const computation = stringField(data, "computation", invalid);
  const executor = projectExecutor(data, invalid);
  const attester = projectAttester(data, invalid);

  return {
    ...(type === undefined ? {} : { type }),
    title,
    ...(description === undefined ? {} : { description }),
    ...(resource === undefined ? {} : { resource }),
    tags,
    sources: sourceProjection.sources,
    sourceText: sourceProjection.text,
    ...(usageWindow === undefined ? {} : { usageWindow }),
    ...(generated === undefined ? {} : { generated }),
    verified: verification.events,
    ...(verification.tier === undefined ? {} : { trustTier: verification.tier }),
    ...(status === undefined ? {} : { status }),
    staleness,
    ...(runtime === undefined ? {} : { runtime }),
    ...(parameters === undefined ? {} : { parameters }),
    ...(computation === undefined ? {} : { computation }),
    ...(executor === undefined ? {} : { executor }),
    ...(attester === undefined ? {} : { attester }),
  };
}

function stringField(
  data: Record<string, unknown>,
  key: string,
  invalid: (field: string) => void,
): string | undefined {
  if (!Object.hasOwn(data, key)) return undefined;
  if (typeof data[key] === "string") return data[key] as string;
  invalid(key);
  return undefined;
}

function stringArray(
  data: Record<string, unknown>,
  key: string,
  invalid: (field: string) => void,
): string[] {
  if (!Object.hasOwn(data, key)) return [];
  const value = data[key];
  if (!Array.isArray(value)) {
    invalid(key);
    return [];
  }

  const result: string[] = [];
  value.forEach((item, index) => {
    if (typeof item === "string") result.push(item);
    else invalid(`${key}[${index}]`);
  });
  return result;
}

function projectSources(
  data: Record<string, unknown>,
  invalid: (field: string) => void,
): { sources: OkfSource[]; text: string } {
  if (!Object.hasOwn(data, "sources")) return { sources: [], text: "" };
  if (!Array.isArray(data.sources)) {
    invalid("sources");
    return { sources: [], text: "" };
  }

  const sources: OkfSource[] = [];
  const lexical: string[] = [];

  data.sources.forEach((value, index) => {
    const base = `sources[${index}]`;
    if (!isRecord(value)) {
      invalid(base);
      return;
    }

    const resource = sourceString(value, "resource", `${base}.resource`, invalid);
    const id = optionalSourceString(value, "id", `${base}.id`, invalid);
    const title = optionalSourceString(value, "title", `${base}.title`, invalid);
    const author = optionalActor(value, "author", `${base}.author`, invalid);
    lexical.push(...[id, title, author, resource].filter(
      (item): item is string => item !== undefined,
    ));

    let valid = resource !== undefined;
    let usageCount: number | undefined;
    if (Object.hasOwn(value, "usage_count")) {
      if (typeof value.usage_count === "number") usageCount = value.usage_count;
      else {
        invalid(`${base}.usage_count`);
        valid = false;
      }
    }

    let lastModified: string | undefined;
    if (Object.hasOwn(value, "last_modified")) {
      if (validTimestamp(value.last_modified)) lastModified = value.last_modified;
      else {
        invalid(`${base}.last_modified`);
        valid = false;
      }
    }

    const window = optionalNestedTimeWindow(value, "usage_window", `${base}.usage_window`, invalid);
    if (Object.hasOwn(value, "usage_window") && window === undefined) valid = false;

    if (valid && resource !== undefined) {
      sources.push({
        resource,
        ...(id === undefined ? {} : { id }),
        ...(title === undefined ? {} : { title }),
        ...(author === undefined ? {} : { author }),
        ...(usageCount === undefined ? {} : { usageCount }),
        ...(lastModified === undefined ? {} : { lastModified }),
        ...(window === undefined ? {} : { usageWindow: window }),
      });
    }
  });

  return { sources, text: lexical.filter(Boolean).join(" ") };
}

function sourceString(
  data: Record<string, unknown>,
  key: string,
  field: string,
  invalid: (field: string) => void,
): string | undefined {
  if (typeof data[key] !== "string") {
    invalid(field);
    return undefined;
  }
  return data[key] as string;
}

function optionalSourceString(
  data: Record<string, unknown>,
  key: string,
  field: string,
  invalid: (field: string) => void,
): string | undefined {
  if (!Object.hasOwn(data, key)) return undefined;
  return sourceString(data, key, field, invalid);
}

function optionalActor(
  data: Record<string, unknown>,
  key: string,
  field: string,
  invalid: (field: string) => void,
): string | undefined {
  if (!Object.hasOwn(data, key)) return undefined;
  if (typeof data[key] !== "string" || !validActor(data[key] as string)) {
    invalid(field);
    return undefined;
  }
  return data[key] as string;
}

function optionalTimeWindow(
  data: Record<string, unknown>,
  key: string,
  invalid: (field: string) => void,
): OkfTimeWindow | undefined {
  if (!Object.hasOwn(data, key)) return undefined;
  return projectTimeWindow(data[key], key, invalid);
}

function optionalNestedTimeWindow(
  data: Record<string, unknown>,
  key: string,
  field: string,
  invalid: (field: string) => void,
): OkfTimeWindow | undefined {
  if (!Object.hasOwn(data, key)) return undefined;
  return projectTimeWindow(data[key], field, invalid);
}

function projectTimeWindow(
  value: unknown,
  base: string,
  invalid: (field: string) => void,
): OkfTimeWindow | undefined {
  if (!isRecord(value)) {
    invalid(base);
    return undefined;
  }
  const from = validTimestamp(value.from) ? value.from : undefined;
  const to = validTimestamp(value.to) ? value.to : undefined;
  if (from === undefined) invalid(`${base}.from`);
  if (to === undefined) invalid(`${base}.to`);
  return from !== undefined && to !== undefined ? { from, to } : undefined;
}

function projectGenerated(
  data: Record<string, unknown>,
  invalid: (field: string) => void,
): NonNullable<OkfDocument["generated"]> | undefined {
  if (!Object.hasOwn(data, "generated")) return undefined;
  if (!isRecord(data.generated)) {
    invalid("generated");
    return undefined;
  }
  const by = typeof data.generated.by === "string" && validActor(data.generated.by)
    ? data.generated.by
    : undefined;
  if (by === undefined) invalid("generated.by");
  let at: string | undefined;
  if (Object.hasOwn(data.generated, "at")) {
    if (validTimestamp(data.generated.at)) at = data.generated.at;
    else invalid("generated.at");
  }
  return by === undefined || (Object.hasOwn(data.generated, "at") && at === undefined)
    ? undefined
    : { by, ...(at === undefined ? {} : { at }) };
}

function projectVerification(
  data: Record<string, unknown>,
  invalid: (field: string) => void,
): { events: OkfVerification[]; tier?: OkfTrustTier } {
  if (!Object.hasOwn(data, "verified")) {
    return { events: [], tier: "unverified" };
  }
  const values = Array.isArray(data.verified)
    ? data.verified
    : isRecord(data.verified)
      ? [data.verified]
      : undefined;
  if (!values) {
    invalid("verified");
    return { events: [] };
  }

  const events: OkfVerification[] = [];
  values.forEach((value, index) => {
    const base = `verified[${index}]`;
    if (!isRecord(value)) {
      invalid(base);
      return;
    }
    const by = typeof value.by === "string" && validActor(value.by)
      ? value.by
      : undefined;
    const at = validTimestamp(value.at) ? value.at : undefined;
    if (by === undefined) invalid(`${base}.by`);
    if (at === undefined) invalid(`${base}.at`);
    if (by !== undefined && at !== undefined) events.push({ by, at });
  });

  if (events.some((event) => event.by.startsWith("human:"))) {
    return { events, tier: "human-reviewed" };
  }
  if (events.length > 0) return { events, tier: "machine-confirmed" };
  return values.length === 0
    ? { events, tier: "unverified" }
    : { events };
}

function projectParameters(
  data: Record<string, unknown>,
  invalid: (field: string) => void,
): NonNullable<OkfDocument["parameters"]> | undefined {
  if (!Object.hasOwn(data, "parameters")) return undefined;
  if (!Array.isArray(data.parameters)) {
    invalid("parameters");
    return undefined;
  }
  const parameters: NonNullable<OkfDocument["parameters"]> = [];
  data.parameters.forEach((value, index) => {
    const base = `parameters[${index}]`;
    if (!isRecord(value)) {
      invalid(base);
      return;
    }
    const name = typeof value.name === "string" ? value.name : undefined;
    const type = typeof value.type === "string" ? value.type : undefined;
    const required = typeof value.required === "boolean" ? value.required : undefined;
    if (name === undefined) invalid(`${base}.name`);
    if (type === undefined) invalid(`${base}.type`);
    if (required === undefined) invalid(`${base}.required`);
    if (name !== undefined && type !== undefined && required !== undefined) {
      parameters.push({ name, type, required });
    }
  });
  return parameters;
}

function projectExecutor(
  data: Record<string, unknown>,
  invalid: (field: string) => void,
): NonNullable<OkfDocument["executor"]> | undefined {
  if (!Object.hasOwn(data, "executor")) return undefined;
  if (!isRecord(data.executor)) {
    invalid("executor");
    return undefined;
  }
  const resource = typeof data.executor.resource === "string"
    ? data.executor.resource
    : undefined;
  if (resource === undefined) invalid("executor.resource");
  let receipt: string[] | undefined;
  if (!Array.isArray(data.executor.receipt)) {
    invalid("executor.receipt");
  } else {
    const validReceipt: string[] = [];
    data.executor.receipt.forEach((value, index) => {
      if (typeof value === "string") validReceipt.push(value);
      else invalid(`executor.receipt[${index}]`);
    });
    receipt = validReceipt.length === data.executor.receipt.length
      ? validReceipt
      : undefined;
  }
  return resource !== undefined && receipt !== undefined
    ? { resource, receipt }
    : undefined;
}

function projectAttester(
  data: Record<string, unknown>,
  invalid: (field: string) => void,
): NonNullable<OkfDocument["attester"]> | undefined {
  if (!Object.hasOwn(data, "attester")) return undefined;
  if (!isRecord(data.attester)) {
    invalid("attester");
    return undefined;
  }
  if (typeof data.attester.resource !== "string") {
    invalid("attester.resource");
    return undefined;
  }
  return { resource: data.attester.resource };
}

function buildStrictDocument(
  data: Record<string, unknown>,
  documentId: string,
  type: string,
  frontmatter: ReturnType<typeof splitFrontmatter>,
  fields: ProjectedFields,
  facets: StrictPreparedOkfFacets,
): OkfDocument {
  return {
    id: documentId,
    type,
    title: fields.title,
    tags: [...fields.tags],
    sources: fields.sources.map((source) => ({
      ...source,
      ...(source.usageWindow ? { usageWindow: { ...source.usageWindow } } : {}),
    })),
    verified: fields.verified.map((event) => ({ ...event })),
    body: frontmatter.body,
    extensions: Object.fromEntries(
      Object.entries(data).filter(([key]) => !STANDARD_KEYS.has(key)),
    ),
    ...(fields.description === undefined ? {} : { description: fields.description }),
    ...(fields.resource === undefined ? {} : { resource: fields.resource }),
    ...(fields.usageWindow === undefined ? {} : { usageWindow: { ...fields.usageWindow } }),
    ...(fields.generated === undefined ? {} : { generated: { ...fields.generated } }),
    status: facets.status.value,
    ...(facets.staleness.staleAfter === undefined ? {} : { staleAfter: facets.staleness.staleAfter }),
    ...(fields.runtime === undefined ? {} : { runtime: fields.runtime }),
    ...(fields.parameters === undefined ? {} : {
      parameters: fields.parameters.map((parameter) => ({ ...parameter })),
    }),
    ...(fields.computation === undefined ? {} : { computation: fields.computation }),
    ...(fields.executor === undefined ? {} : {
      executor: { ...fields.executor, receipt: [...fields.executor.receipt] },
    }),
    ...(fields.attester === undefined ? {} : { attester: { ...fields.attester } }),
  };
}

function buildPreparedSections(
  documentId: string,
  conceptSections: Section[],
  body: string,
  bodyStartLine: number,
): NonEmptyPreparedOkfSections {
  const lines = body.split(/\r\n|\n|\r/);
  const slugCounts = new Map<string, number>();
  const prepared = conceptSections.flatMap((section) => {
    const sectionId = uniqueSlug(section.slug, slugCounts);
    return chunkSection(lines, bodyStartLine, section).map((value, index, all) => ({
      id: all.length === 1
        ? `${documentId}#${sectionId}`
        : `${documentId}#${sectionId}--part-${index + 1}`,
      headingPath: section.headingPath,
      ...value,
    }));
  });
  const first = prepared[0];
  if (!first) {
    throw new Error("OKF preparation requires at least one section");
  }

  return [first, ...prepared.slice(1)];
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && parseTimestamp(value) !== undefined;
}

function splitFrontmatter(
  markdown: string,
  path: string,
): { yaml: string; body: string; bodyStartLine: number } {
  const opening = markdown.startsWith("---\r\n") ? 5 : markdown.startsWith("---\n") ? 4 : 0;
  if (!opening) throw new PrepareError("ERR_OKF_PARSE", path);
  const remainder = markdown.slice(opening);
  const closing = remainder.match(/(?:^|\r?\n)---(?:\r?\n|$)/);
  if (!closing || closing.index === undefined) throw new PrepareError("ERR_OKF_PARSE", path);
  const yaml = remainder.slice(0, closing.index);
  const prefixLength = opening + closing.index + closing[0].length;
  const prefix = markdown.slice(0, prefixLength);
  return {
    yaml,
    body: markdown.slice(prefixLength),
    bodyStartLine: (prefix.match(/\r\n|\n/g)?.length ?? 0) + 1,
  };
}

function sections(
  body: string,
  title: string,
  bodyStartLine: number,
): Section[] {
  const result: Section[] = [];

  const stack: Array<{
    depth: number;
    text: string;
  }> = [];

  let current: Section = {
    headingPath: title,
    slug: "root",
    blocks: [],
  };

  for (const node of fromMarkdown(body).children) {
    if (node.type !== "heading") {
      if (node.position) {
        current.blocks.push(
          node as PositionedBlock,
        );
      }

      continue;
    }

    if (
      current.headingLine !== undefined ||
      current.blocks.length > 0
    ) {
      result.push(current);
    }

    const depth =
      "depth" in node &&
      typeof node.depth === "number"
        ? node.depth
        : 1;

    while (
      stack.at(-1)?.depth &&
      stack.at(-1)!.depth >= depth
    ) {
      stack.pop();
    }

    const text =
      nodeText(node).trim() || "Untitled section";

    stack.push({ depth, text });

    const headingPath = stack
      .map((item) => item.text)
      .join(" > ");

    current = {
      headingPath,
      slug: slug(headingPath),

      headingLine:
        bodyStartLine +
        (node.position?.start.line ?? 1) -
        1,

      blocks: [],
    };
  }

  if (
    current.headingLine !== undefined ||
    current.blocks.length > 0 ||
    !result.length
  ) {
    result.push(current);
  }

  return result;
}

function chunkSection(
  lines: string[],
  bodyStartLine: number,
  section: Section,
): Chunk[] {
  const blocks = section.blocks.map((block) => ({
    block,
    words: wordCount(
      slice(lines, block.position),
    ),
  }));

  const totalWords = blocks.reduce(
    (sum, item) => sum + item.words,
    0,
  );

  if (totalWords <= MAX_SECTION_WORDS) {
    return [
      chunk(
        lines,
        bodyStartLine,
        section,
        section.blocks,
        true,
      ),
    ];
  }

  const groups: PositionedBlock[][] = [[]];
  const groupWords: number[] = [0];

  for (const item of blocks) {
    let last = groups.length - 1;

    if (
      groups[last]!.length > 0 &&
      groupWords[last]! + item.words >
        TARGET_CHUNK_WORDS
    ) {
      groups.push([]);
      groupWords.push(0);
      last += 1;
    }

    groups[last]!.push(item.block);
    groupWords[last] =
      groupWords[last]! + item.words;
  }

  if (
    groups.length > 1 &&
    groupWords.at(-1)! <
      TARGET_CHUNK_WORDS / 2
  ) {
    groups.at(-2)!.push(...groups.at(-1)!);
    groups.pop();
  }

  return groups.map((blocks, index) =>
    chunk(
      lines,
      bodyStartLine,
      section,
      blocks,
      index === 0,
    ),
  );
}

function chunk(
  lines: string[],
  bodyStartLine: number,
  section: Section,
  blocks: PositionedBlock[],
  includeHeading: boolean,
): Chunk {
  if (!blocks.length) {
    const line =
      section.headingLine ?? bodyStartLine;

    return {
      text: "",
      startLine: line,
      endLine: line,
    };
  }

  const first =
    blocks[0]!.position.start.line;

  const last =
    blocks.at(-1)!.position.end.line;

  return {
    text: lines
      .slice(first - 1, last)
      .join("\n")
      .trim(),

    startLine:
      includeHeading &&
      section.headingLine !== undefined
        ? section.headingLine
        : bodyStartLine + first - 1,

    endLine:
      bodyStartLine + last - 1,
  };
}

function validActor(value: string): boolean {
  return /^human:\S+$/.test(value) ||
    /^process:\S+$/.test(value) ||
    /^[^\s/]+\/[^\s/]+$/.test(value);
}

function parseTimestamp(
  value: string,
): number | undefined {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/,
  );

  if (!match) {
    return undefined;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const millisecond = Number(
    fraction.slice(0, 3).padEnd(3, "0"),
  );
  const roundsUp = /[1-9]/.test(
    fraction.slice(3),
  );
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);

  if (
    month < 1 || month > 12 ||
    day < 1 || day > daysInMonth(year, month) ||
    hour > 23 || minute > 59 || second > 59 ||
    offsetHour > 23 || offsetMinute > 59
  ) {
    return undefined;
  }

  const local = new Date(0);
  local.setUTCHours(
    hour,
    minute,
    second,
    millisecond,
  );
  local.setUTCFullYear(year, month - 1, day);

  const offset = match[8] === "Z"
    ? 0
    : (match[9] === "+" ? 1 : -1) *
      (offsetHour * 60 + offsetMinute) *
      60_000;
  const epoch = local.getTime() - offset;

  return Number.isFinite(epoch)
    ? epoch + (roundsUp ? 1 : 0)
    : undefined;
}

function daysInMonth(
  year: number,
  month: number,
): number {
  if (month === 2) {
    return year % 4 === 0 &&
      (year % 100 !== 0 || year % 400 === 0)
      ? 29
      : 28;
  }

  return [4, 6, 9, 11].includes(month)
    ? 30
    : 31;
}

function nodeText(node: Node): string {
  const value = node as Node & {
    value?: unknown;
    children?: Node[];
  };

  return [
    typeof value.value === "string"
      ? value.value
      : "",

    ...(value.children?.map(nodeText) ?? []),
  ]
    .filter(Boolean)
    .join(" ");
}

function slice(
  lines: string[],
  position: Position,
): string {
  return lines
    .slice(
      position.start.line - 1,
      position.end.line,
    )
    .join("\n");
}

function uniqueSlug(
  value: string,
  counts: Map<string, number>,
): string {
  const count =
    (counts.get(value) ?? 0) + 1;

  counts.set(value, count);

  return count === 1
    ? value
    : `${value}--${count}`;
}

function slug(value: string): string {
  return (
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(
        /[^\p{L}\p{N}]+/gu,
        "-",
      )
      .replace(/^-+|-+$/g, "") ||
    "section"
  );
}

function titleFromId(id: string): string {
  const title = (
    id.split("/").at(-1) ?? id
  ).replace(/[-_]+/g, " ");

  return (
    title.charAt(0).toUpperCase() +
    title.slice(1)
  );
}

function wordCount(value: string): number {
  return (
    value.match(
      /[\p{L}\p{N}_]+/gu,
    )?.length ?? 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
