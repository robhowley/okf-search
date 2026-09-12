import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { oracleInputs } from "../../okf-prepare/scripts/oracle-inputs.mjs";
import { fingerprintCorpusFiles } from "../../okf-prepare/scripts/corpus-support.mjs";

export const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const yamlIds = [
  "yaml-1.2-values", "aliases-and-cycles", "tagged-values", "accepted-string-key-forms",
  "non-string-root-number", "non-string-nested", "non-string-alias-number",
  "non-string-set", "non-string-merge-source",
  "yaml-1.2-invalid-explicit-timestamp-remains-fatal",
  "alias-limit-near-threshold-accepted", "alias-limit-over-threshold",
];
export const transportExclusion = "lone-surrogate-path-and-body";

export async function smallInputs() {
  const fixture = JSON.parse(await readFile(resolve(repoRoot,
    "packages/okf-prepare/test/fixtures/phase-1-parity-v1.json"), "utf8"));
  const cases = oracleInputs();
  for (const id of yamlIds) {
    const matches = fixture.yaml.filter((entry) => entry.id === id);
    if (matches.length !== 1) throw new Error("YAML inventory mismatch");
    const entry = matches[0];
    const source = Object.hasOwn(entry, "source") ? entry.source
      : entry.sourceUnits.map((unit) => String.fromCharCode(unit)).join("");
    cases.push({ id, input: { path: `probes/${id}.md`, markdown: `---\n${source}\n---\nbody` } });
  }
  const focused = [
    ["stale-degraded-zero", "type: note\ntitle: 1\nstale_after: 1970-01-01T00:00:00Z"],
    ["stale-degraded-fraction", "type: note\ntitle: 1\nstale_after: 1970-01-01T00:00:00.0001Z"],
    ["optional-null", "type: note\ndescription: null\nstatus: null\nstale_after: null"],
    ["optional-empty-false-zero", 'type: note\ntitle: ""\nparameters: [{name: "", type: "", required: false}]\nsources: [{resource: "", usage_count: 0}]'],
    ["usage-safe-integer", "type: note\nsources: [{resource: source, usage_count: 9007199254740991}]"],
    ["usage-next-integer", "type: note\nsources: [{resource: source, usage_count: 9007199254740992}]"],
    ["empty-body", "type: note", ""],
    ["chunk-800-words", "type: note", Array.from({ length: 8 }, () => Array(100).fill("word").join(" ")).join("\n\n")],
  ];
  for (const [id, yaml, body = "body"] of focused) {
    cases.push({ id, input: { path: `focused/${id}.md`, markdown: `---\n${yaml}\n---\n${body}` } });
  }
  const root = resolve(repoRoot, "demo/assets/sample-bundle");
  const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
  const fingerprint = await fingerprintCorpusFiles(root);
  // Same checks as oracle-fixtures; keep that capture's only change the input extraction.
  const expected = new Map(manifest.documents.map(({ path, bytes }) => [path, bytes]));
  if (manifest.documentCount !== 42 || manifest.totalBytes !== 57038
    || fingerprint.documents !== manifest.documentCount || fingerprint.bytes !== manifest.totalBytes
    || expected.size !== manifest.documents.length || fingerprint.files.length !== manifest.documents.length
    || fingerprint.files.some(({ path, bytes }) => expected.get(path) !== bytes)) {
    throw new Error("Demo manifest mismatch");
  }
  for (const { path } of fingerprint.files) {
    cases.push({ id: `demo/${path}`, input: { path, markdown: await readFile(resolve(root, path), "utf8") } });
  }
  if (cases.length !== 72 || new Set(cases.map(({ id }) => id)).size !== 72) throw new Error("Small inventory mismatch");
  for (const entry of cases) {
    if (entry.id !== transportExclusion && (!entry.input.path.isWellFormed() || !entry.input.markdown.isWellFormed())) throw new Error("Unexpected native transport exclusion");
  }
  return cases.map((entry) => ({ ...entry, nativeExcluded: entry.id === transportExclusion }));
}
