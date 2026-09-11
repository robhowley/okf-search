import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, realpath, stat, writeFile, readdir } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { homedir, release } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertPrivateCorpus, fingerprintCorpusFiles } from "../../okf-prepare/scripts/corpus-support.mjs";
import { repoRoot, smallInputs } from "./comparison-inputs.mjs";
import { capture, compareCaptures, decode, differences, encode } from "./comparison-values.mjs";

export const BASELINE = "736b4ec7e23ddb78d9c73fe366f1c97230d1c2b2";
const script = fileURLToPath(import.meta.url);
const nativeRoot = resolve(repoRoot, "packages/okf-prepare-native");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => `${JSON.stringify(value)}\n`;
const save = (path, value) => writeFile(path, json(value), { mode: 0o600, flag: "wx" });
const git = (...args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
const inside = (root, path) => { const rel = relative(root, path); return !rel || (!rel.startsWith("..") && !isAbsolute(rel)); };

export function parseArgs(args) {
  if (args.length !== 4 || args[0] !== "--suite" || !["small", "corpus"].includes(args[1]) || args[2] !== "--out" || !args[3]) throw new Error("Invalid invocation");
  return { suite: args[1], out: resolve(args[3]) };
}

async function checkoutProvenance() {
  const paths = new Set(git("ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean));
  async function addBuilt(directory) {
    for (const entry of await readdir(resolve(repoRoot, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await addBuilt(path);
      else if (entry.isFile()) paths.add(path);
    }
  }
  await addBuilt("packages/okf-prepare/dist");
  await addBuilt("packages/okf-prepare-native/dist");
  paths.add("packages/okf-prepare-native/okf-prepare-native.node");
  const hashes = {};
  for (const path of [...paths].sort()) {
    try { hashes[path] = sha(await readFile(resolve(repoRoot, path))); }
    catch (error) { if (error.code === "ENOENT") hashes[path] = null; else throw error; }
  }
  return { commit: git("rev-parse", "HEAD").trim(), dirty: git("status", "--porcelain=v1", "--untracked-files=all"), hashes };
}

// Exported for synthetic tests; production callers always load the real modules below.
export function captureInput(entry, jsApi, nativeApi) {
  const js = [capture("js", jsApi, entry.input), capture("js", jsApi, entry.input)];
  if (differences(js[0], js[1]).length) throw new Error("Nondeterministic JS capture");
  const native = entry.nativeExcluded ? [] : [capture("native", nativeApi, entry.input), capture("native", nativeApi, entry.input)];
  if (native.length && differences(native[0], native[1]).length) throw new Error("Nondeterministic native capture");
  return { id: entry.id, nativeExcluded: Boolean(entry.nativeExcluded), js, native,
    differences: native.length ? compareCaptures(js[0], native[0]) : [] };
}

async function child(requestPath, resultPath) {
  // Inputs and the CLI have already been verified and snapshotted before addon loading.
  const entries = decode(JSON.parse(await readFile(requestPath, "utf8")));
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 256
    || entries.some((entry) => typeof entry.id !== "string" || typeof entry.input?.path !== "string" || typeof entry.input?.markdown !== "string")) throw new Error("Invalid chunk");
  const jsApi = await import("../../okf-prepare/dist/index.js");
  const nativeApi = await import("../dist/index.js");
  await writeFile(resultPath, "", { flag: "wx", mode: 0o600 });
  let bytes = 0;
  for (const entry of entries) {
    const { differences: _, ...record } = captureInput(entry, jsApi, nativeApi);
    const line = json(encode(record));
    bytes += Buffer.byteLength(line);
    if (bytes > 128 * 1024 ** 2) throw new Error("Chunk artifact bound exceeded");
    await appendFile(resultPath, line);
  }
}

let activeChild;
export async function runChild(request, result, timeout = 120000) {
  await new Promise((accept, reject) => {
    const processChild = spawn(process.execPath, [script, "--child", request, result], { cwd: repoRoot, stdio: "ignore" });
    activeChild = processChild;
    const timer = setTimeout(() => { processChild.kill("SIGKILL"); }, timeout);
    processChild.once("error", (error) => { clearTimeout(timer); activeChild = undefined; reject(error); });
    processChild.once("exit", (code, signal) => {
      clearTimeout(timer); activeChild = undefined;
      if (code === 0 && !signal) accept(); else reject(new Error(`Chunk execution failed or timed out (exit ${code}, signal ${signal})`));
    });
  });
}

export async function run(args) {
  process.umask(0o077);
  let options;
  try {
    options = parseArgs(args);
    if (git("rev-parse", "HEAD").trim() !== BASELINE) return 2;
    const parent = await realpath(dirname(options.out));
    options.out = resolve(parent, options.out.split(/[\\/]/).at(-1));
    if (inside(await realpath(repoRoot), options.out) || ((await stat(parent)).mode & 0o077)) return 2;
    // Also reject another checkout (or its .git directory), not just this worktree.
    let repositoryParent = false;
    try {
      execFileSync("git", ["rev-parse", "--git-dir"], { cwd: parent, timeout: 10000, stdio: "ignore" });
      repositoryParent = true;
    } catch { /* A private directory outside Git is required. */ }
    if (repositoryParent) return 2;
    try { await mkdir(options.out, { mode: 0o700 }); }
    catch (error) { return error.code === "EEXIST" ? 2 : 3; }
  } catch { return 2; }
  const { suite, out } = options;
  const started = Date.now();
  const counts = { selected: 0, captured: 0, jsCaptures: 0, nativeCaptures: 0, excluded: 0, differingDocuments: 0, fieldDifferences: 0,
    jsOutcomes: { strict: 0, degraded: 0, fatal: 0 }, nativeOutcomes: { strict: 0, degraded: 0, fatal: 0 }, outcomePairs: {} };
  const manifest = { schemaVersion: 1, suite, started: new Date(started).toISOString(), state: "incomplete", counts,
    limits: { chunkDocuments: 256, chunkMillis: 120000, stageMillis: suite === "small" ? 300000 : 1800000, artifactBytes: 2 * 1024 ** 3, detailedExamplesPerCategory: suite === "corpus" ? 3 : 72 } };
  const manifestPath = resolve(out, "manifest.json");
  const updateManifest = () => writeFile(manifestPath, json(manifest), { mode: 0o600 });
  const timer = setTimeout(() => {
    activeChild?.kill("SIGKILL");
    manifest.failure = "stage-timeout";
    try { writeFileSync(manifestPath, json(manifest), { mode: 0o600 }); } catch { /* Exit remains failure. */ }
    process.exit(3);
  }, manifest.limits.stageMillis);
  let phase = "runtime";
  try {
    await updateManifest();
    manifest.before = await checkoutProvenance();
    if (manifest.before.commit !== BASELINE) throw new Error("Baseline changed");
    let entries;
    phase = "input";
    if (suite === "small") entries = await smallInputs();
    else {
      const corpus = await realpath(process.env.OKF_CORPUS || resolve(homedir(), "Documents/wiki-w-type"));
      const fingerprint = await fingerprintCorpusFiles(corpus);
      assertPrivateCorpus(fingerprint);
      manifest.corpus = { path: corpus, ...fingerprint };
      phase = "runtime";
      const snapshot = resolve(out, "snapshot");
      await mkdir(snapshot, { mode: 0o700 });
      for (const { path } of fingerprint.files) {
        const destination = resolve(snapshot, path);
        if (!inside(snapshot, destination)) throw new Error("Unsafe corpus path");
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await copyFile(resolve(corpus, path), destination);
      }
      phase = "runtime";
      const snapshotFingerprint = await fingerprintCorpusFiles(snapshot);
      assertPrivateCorpus(snapshotFingerprint);
      manifest.snapshot = snapshotFingerprint;
      entries = [];
      for (const { path } of snapshotFingerprint.files) {
        const bytes = await readFile(resolve(snapshot, path));
        const markdown = bytes.toString("utf8");
        if (!Buffer.from(markdown, "utf8").equals(bytes)) throw new Error("Non-UTF8 corpus input");
        entries.push({ id: path, input: { path, markdown }, nativeExcluded: false });
      }
    }
    phase = "runtime";
    counts.selected = entries.length;
    manifest.inputs = entries.map(({ id, input, nativeExcluded }) => ({ id, sha256: sha(json(encode(input))), nativeExcluded: Boolean(nativeExcluded) }));
    const tool = (name, args) => execFileSync(name, args, { cwd: nativeRoot, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }).trim();
    manifest.environment = { node: process.version, platform: process.platform, architecture: process.arch, os: release(), rustc: tool("rustc", ["-vV"]), cargo: tool("cargo", ["--version"]), pnpm: tool("pnpm", ["--version"]) };
    manifest.parsers = JSON.parse(await readFile(resolve(repoRoot, "packages/okf-prepare/package.json"), "utf8")).dependencies;
    const cargoLock = await readFile(resolve(nativeRoot, "Cargo.lock"), "utf8");
    manifest.nativeParserVersions = Object.fromEntries([...cargoLock.matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/g)]
      .filter(([, name]) => ["comrak", "saphyr", "saphyr-parser", "time"].includes(name)).map(([, name, version]) => [name, version]));
    manifest.addonSha256 = manifest.before.hashes["packages/okf-prepare-native/okf-prepare-native.node"];
    if (!manifest.addonSha256) throw new Error("Missing addon");
    await save(resolve(out, "exclusions.json"), entries.filter((e) => e.nativeExcluded).map(({ id }) => ({ id, reason: "unsupported transport: lone UTF-16 surrogate; JS-only" })));
    await updateManifest();
    const categories = new Map();
    for (let offset = 0; offset < entries.length; offset += 256) {
      const name = String(offset / 256).padStart(4, "0");
      const request = resolve(out, `inputs-${name}.json`);
      const result = resolve(out, `captures-${name}.jsonl`);
      await save(request, encode(entries.slice(offset, offset + 256)));
      manifest.currentChunk = name;
      await updateManifest();
      await runChild(request, result);
      const lines = (await readFile(result, "utf8")).trimEnd().split("\n");
      if (lines.length !== Math.min(256, entries.length - offset)) throw new Error("Incomplete chunk");
      for (let index = 0; index < lines.length; index++) {
        const record = decode(JSON.parse(lines[index]));
        if (record.id !== entries[offset + index].id) throw new Error("Chunk identity mismatch");
        record.differences = record.nativeExcluded ? [] : compareCaptures(record.js[0], record.native[0]);
        const outcome = (capture) => capture.preparation.kind === "fatal" ? "fatal" : capture.preparation.conformance;
        const jsOutcome = outcome(record.js[0]);
        const nativeOutcome = record.nativeExcluded ? "excluded" : outcome(record.native[0]);
        counts.jsOutcomes[jsOutcome]++;
        if (!record.nativeExcluded) counts.nativeOutcomes[nativeOutcome]++;
        const pair = `${jsOutcome}/${nativeOutcome}`;
        counts.outcomePairs[pair] = (counts.outcomePairs[pair] ?? 0) + 1;
        counts.captured++; counts.jsCaptures += 2;
        counts.nativeCaptures += record.nativeExcluded ? 0 : 2;
        counts.excluded += Number(record.nativeExcluded);
        counts.differingDocuments += Number(record.differences.length > 0);
        counts.fieldDifferences += record.differences.length;
        for (const difference of record.differences) {
          const category = difference.path.replace(/\["\d+"\]/g, "[]");
          if (!categories.has(category)) categories.set(category, { category, count: 0, ids: new Set(), examples: [] });
          const item = categories.get(category);
          item.count++; item.ids.add(record.id);
          let example = item.examples.find((e) => e.id === record.id);
          if (!example && item.examples.length < manifest.limits.detailedExamplesPerCategory) {
            example = { id: record.id, inputArtifact: `inputs-${name}.json`, captureArtifact: `captures-${name}.jsonl`, differences: [] };
            item.examples.push(example);
          }
          // One detailed field occurrence per document/category; complete captures retain all evidence.
          if (example && !example.differences.length) example.differences.push(difference);
        }
      }
      await writeFile(resolve(out, "differences.json"), json([...categories.values()].map((item) => ({ ...item, ids: [...item.ids] }))), { mode: 0o600 });
      await writeFile(resolve(out, "classification-ledger.json"), json([...categories.keys()].map((category) => ({ category, classification: null, authority: null, disposition: null, reproducer: "See differences.json and referenced private inputs/captures" }))), { mode: 0o600 });
      await updateManifest();
      let artifactBytes = 0;
      async function measure(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = resolve(directory, entry.name);
          if (entry.isDirectory()) await measure(path); else artifactBytes += (await stat(path)).size;
        }
      }
      await measure(out);
      if (artifactBytes > manifest.limits.artifactBytes) throw new Error("Artifact bound exceeded");
      manifest.artifactBytes = artifactBytes;
    }
    manifest.after = await checkoutProvenance();
    if (differences(manifest.before, manifest.after).length) throw new Error("Checkout mutated");
    if (suite === "corpus") assertPrivateCorpus(await fingerprintCorpusFiles(resolve(out, "snapshot")));
    for (let offset = 0; offset < entries.length; offset += 256) {
      const path = resolve(out, `inputs-${String(offset / 256).padStart(4, "0")}.json`);
      if (sha(await readFile(path)) !== sha(json(encode(entries.slice(offset, offset + 256))))) throw new Error("Input snapshot mutated");
    }
    manifest.state = "capture-complete-unclassified";
    manifest.elapsedMillis = Date.now() - started;
    await updateManifest();
    return 0;
  } catch (error) {
    manifest.failure = phase === "input" ? "invalid-input" : "execution-failure";
    manifest.error = { name: error.name, message: error.message };
    try { await updateManifest(); } catch { return 3; }
    return phase === "input" ? 2 : 3;
  } finally { clearTimeout(timer); activeChild?.kill("SIGKILL"); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] === "--child" && process.argv.length === 5) {
    try { await child(process.argv[3], process.argv[4]); }
    catch (error) {
      try { await save(`${process.argv[4]}.error.json`, { name: error.name, message: error.message }); } catch { /* Preserve failure exit. */ }
      process.exitCode = 3;
    }
  } else {
    process.exitCode = await run(process.argv.slice(2));
    console.log(`Comparison exit ${process.exitCode}; see private artifacts for status.`);
  }
}
