#!/usr/bin/env node

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { verifyPublicationPlan } from "./release-publication.mjs"
import { resolveCommandShape } from "./command-shape.mjs"
import { NPM_REGISTRY } from "./npm-registry-state.mjs"

const JS_PACKAGES = new Set(["okf-minisearch", "pi-okf-search"])
const NATIVE_PACKAGE = "okf-search-native"
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const piPackageManifest = JSON.parse(await readFile(new URL("../packages/pi-okf-search/package.json", import.meta.url), "utf8"))
const PI_HOST_DEPENDENCIES = Object.fromEntries(
  Object.keys(piPackageManifest.peerDependencies).map((name) => [name, piPackageManifest.devDependencies?.[name]]),
)
for (const [name, version] of Object.entries(PI_HOST_DEPENDENCIES)) assert.match(version ?? "", SEMVER, `exact Pi host version for ${name}`)

function consumerDependencies(name, dependency, selectedNative) {
  const dependencies = { [name]: dependency }
  if (name === "pi-okf-search") {
    if (selectedNative) dependencies[NATIVE_PACKAGE] = selectedNative
    Object.assign(dependencies, PI_HOST_DEPENDENCIES)
  }
  return dependencies
}

function fail(message) {
  throw new Error(message)
}

function run(command, args, cwd, env = process.env, capture = false, onCommand, runCommand = spawnSync) {
  const shape = resolveCommandShape(command, args)
  onCommand?.({ command: shape.command, args: [...shape.args], cwd, capture })
  const result = runCommand(shape.command, shape.args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  })
  if (result.error) throw result.error
  if (result.status !== 0) fail(`${command} ${args.join(" ")} exited with ${result.status}${result.stderr ? `: ${result.stderr.trim()}` : ""}`)
  return result.stdout?.trim() ?? ""
}

export async function runConsumerEntry(root, filename, source, env = process.env, onCommand, runCommand = spawnSync) {
  const entry = join(root, filename)
  await writeFile(entry, source)
  run(process.execPath, [entry], root, env, false, onCommand, runCommand)
}

const searchSmokeEntry = `
import assert from "node:assert/strict"
import * as api from "okf-minisearch"

assert.deepEqual(Object.keys(api).sort(), ["OkfError", "createOkfSearch", "openOkf", "validateOkfDocument"])
const index = api.createOkfSearch([{
  path: "release.md",
  markdown: "---\\ntype: release\\n---\\nexact-version-js-smoke\\n",
}])
assert.equal(index.search("exact-version-js-smoke")[0]?.documentId, "release")
`

async function searchSmoke(root, onCommand, runCommand) {
  await runConsumerEntry(root, "minisearch-smoke.mjs", searchSmokeEntry, process.env, onCommand, runCommand)
}

async function piSmoke(root, packageRoot, onCommand, runCommand) {
  const agentDir = join(root, "agent")
  const fixtureDir = join(root, "fixture")
  await mkdir(agentDir)
  await mkdir(fixtureDir)
  await writeFile(join(fixtureDir, "marker.md"), "---\ntype: note\ntitle: Registry smoke\n---\nexact-version-pi-smoke\n")
  await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({
    packages: [packageRoot],
    "pi-okf-search": { root: "../fixture" },
  }, null, 2)}\n`)

  await runConsumerEntry(root, "pi-smoke.mjs", `
import assert from "node:assert/strict"
import { createOkfSearch } from "okf-search-native"
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent"

const index = createOkfSearch([{ path: "release.md", markdown: "---\\ntype: release\\n---\\nexact-version-native-smoke\\n" }])
assert.equal(index.search("exact-version-native-smoke")[0]?.documentId, "release")
const root = process.cwd()
const agentDir = process.env.PI_CODING_AGENT_DIR
const settingsManager = SettingsManager.create(root, agentDir)
const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true })
await loader.reload()
const loaded = loader.getExtensions()
assert.deepEqual(loaded.errors, [])
assert.equal(loaded.extensions.length, 1)
const tool = loaded.extensions[0].tools.get("okf_search")
assert.ok(tool)
const context = { cwd: root, mode: "json", hasUI: false, isProjectTrusted: () => true, ui: { notify() {} } }
const handlers = loaded.extensions[0].handlers.get("session_start") ?? []
assert.equal(handlers.length, 1)
await handlers[0]({ type: "session_start", reason: "startup" }, context)
const result = await tool.definition.execute("registry-smoke", { query: "exact-version-pi-smoke" }, undefined, undefined, context)
assert.match(result.content.map(({ text }) => text ?? "").join("\\n"), /Registry smoke/)
`, { ...process.env, PI_CODING_AGENT_DIR: agentDir }, onCommand, runCommand)
}

async function fileMap(root, directory = root) {
  const files = new Map()
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.name.startsWith("._") || entry.name === "node_modules") continue
    if (entry.isDirectory()) {
      for (const [name, hash] of await fileMap(root, path)) files.set(name, hash)
    } else {
      assert.equal(entry.isFile(), true, `installed package has non-regular file ${entry.name}`)
      const relative = path.slice(root.length + 1).split(sep).join("/")
      files.set(relative, createHash("sha256").update(await readFile(path)).digest("hex"))
    }
  }
  return files
}

async function assertInstalledBytes(tarball, packageRoot, onCommand, runCommand) {
  const extracted = await mkdtemp(join(tmpdir(), "okf-js-tarball-bytes-"))
  try {
    run("tar", ["-xzf", basename(tarball), "-C", extracted], dirname(tarball), process.env, false, onCommand, runCommand)
    assert.deepEqual(await fileMap(packageRoot), await fileMap(join(extracted, "package")), `installed files differ from ${basename(tarball)}`)
  } finally {
    await rm(extracted, { recursive: true, force: true })
  }
}

function nativeNodes(tree, nodes = []) {
  const dependencies = tree?.dependencies ?? {}
  for (const [name, node] of Object.entries(dependencies)) {
    if (name === NATIVE_PACKAGE) nodes.push(node)
    nativeNodes(node, nodes)
  }
  return nodes
}

async function assertPiResolvesRootNative(root, piRoot, onCommand, runCommand) {
  const resolver = `process.stdout.write(import.meta.resolve('${NATIVE_PACKAGE}'))\n`
  const piResolver = join(piRoot, "resolve-okf-search-native.mjs")
  const rootResolver = join(root, "resolve-okf-search-native.mjs")
  try {
    await writeFile(piResolver, resolver)
    await writeFile(rootResolver, resolver)
    const piResolved = run(process.execPath, [piResolver], root, process.env, true, onCommand, runCommand)
    const rootResolved = run(process.execPath, [rootResolver], root, process.env, true, onCommand, runCommand)
    assert.equal(await realpath(fileURLToPath(piResolved)), await realpath(fileURLToPath(rootResolved)), "Pi resolves a different okf-search-native instance")
  } finally {
    await rm(piResolver, { force: true })
    await rm(rootResolver, { force: true })
  }
}

async function assertPiUsesSelectedNative(root, piRoot, nativeEntry, nativeTarball, onCommand, runCommand) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm"
  const tree = JSON.parse(run(npm, ["ls", NATIVE_PACKAGE, "--all", "--json", "--long"], root, process.env, true, onCommand, runCommand))
  const nodes = nativeNodes(tree)
  assert.ok(nodes.length > 0, "npm dependency tree has no okf-search-native")
  for (const node of nodes) {
    assert.equal(node.version, nativeEntry.version, "npm dependency tree selected another okf-search-native version")
    if (node.resolved !== undefined) {
      assert.doesNotMatch(node.resolved, /^https:\/\/registry\.npmjs\.org\//, "selected okf-search-native resolved from the registry")
      assert.ok(decodeURIComponent(node.resolved).includes(basename(nativeTarball)), "selected okf-search-native did not resolve from the planned tarball")
    }
  }
  await assertPiResolvesRootNative(root, piRoot, onCommand, runCommand)
}

async function validateInstalledPackage(root, entry, tarball, onCommand, runCommand) {
  const packageRoot = join(root, "node_modules", entry.name)
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
  assert.equal(manifest.name, entry.name, "installed package name mismatch")
  assert.equal(manifest.version, entry.version, "installed package version mismatch")
  if (tarball) await assertInstalledBytes(tarball, packageRoot, onCommand, runCommand)

  if (entry.name === "okf-minisearch") {
    await searchSmoke(root, onCommand, runCommand)
    return
  }
  assert.deepEqual(manifest.pi, { extensions: ["./extensions/okf-search"] }, "Pi extension manifest mismatch")
  for (const file of ["index.ts", "runtime.ts", "config.ts"]) {
    assert.equal((await stat(join(packageRoot, "extensions", "okf-search", file))).isFile(), true, `missing Pi extension file: ${file}`)
  }
  assert.equal(typeof manifest.dependencies?.[NATIVE_PACKAGE], "string", "missing okf-search-native dependency")
  await piSmoke(root, packageRoot, onCommand, runCommand)
}

async function installConsumer(entry, entries, directory, onCommand, runCommand) {
  const root = await mkdtemp(join(tmpdir(), "okf-js-release-consumer-"))
  try {
    const selectedNative = entries.find(({ name }) => name === NATIVE_PACKAGE)
    const dependencies = consumerDependencies(
      entry.name,
      `file:${join(directory, entry.tarball)}`,
      selectedNative && `file:${join(directory, selectedNative.tarball)}`,
    )
    await writeFile(join(root, "package.json"), `${JSON.stringify({
      name: "okf-js-release-consumer",
      version: "1.0.0",
      private: true,
      type: "module",
      dependencies,
    }, null, 2)}\n`)
    const npm = process.platform === "win32" ? "npm.cmd" : "npm"
    run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--registry", NPM_REGISTRY], root, process.env, false, onCommand, runCommand)
    await validateInstalledPackage(root, entry, join(directory, entry.tarball), onCommand, runCommand)
    if (entry.name === "pi-okf-search" && selectedNative) {
      await assertInstalledBytes(join(directory, selectedNative.tarball), join(root, "node_modules", selectedNative.name), onCommand, runCommand)
      await assertPiUsesSelectedNative(root, join(root, "node_modules", entry.name), selectedNative, join(directory, selectedNative.tarball), onCommand, runCommand)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export async function verifyLocalJsConsumers({ directory, plan, expectedCommit = plan.releaseCommit, onCommand, runCommand = spawnSync } = {}) {
  await verifyPublicationPlan({ directory, plan, expectedCommit })
  const entries = plan.packages.filter(({ name }) => JS_PACKAGES.has(name))
  for (const entry of entries) await installConsumer(entry, plan.packages, directory, onCommand, runCommand)
  return entries.map(({ name, version }) => ({ name, version }))
}

export async function verifyNativeConsumer(dependency, { typescript = null, onCommand, runCommand = spawnSync } = {}) {
  assert.ok(isAbsolute(dependency) && dependency.endsWith(".tgz"), "native dependency must be an absolute tarball")
  const root = await mkdtemp(join(tmpdir(), "okf-native-release-consumer-"))
  try {
    await writeFile(join(root, "package.json"), `${JSON.stringify({
      name: "okf-native-release-consumer",
      private: true,
      type: "module",
    }, null, 2)}\n`)
    await mkdir(join(root, "fixture", "nested"), { recursive: true })
    await writeFile(join(root, "fixture", "nested", "directory.md"), "---\ntype: guide\n---\nrelease-directory-needle\n")

    const npm = process.platform === "win32" ? "npm.cmd" : "npm"
    run(npm, [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--save-exact",
      dependency,
    ], root, process.env, false, onCommand, runCommand)

    const entries = {
      "root.mjs": `import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as api from "okf-search-native";
assert.deepEqual(Object.keys(api).sort(), ["OkfError", "createOkfSearch", "openOkf", "validateOkfDocument"]);
await assert.rejects(import("okf-search-native/native.cjs"), (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED");
const raw = { path: "raw.md", markdown: "---\\ntype: note\\n---\\nrelease-raw-needle\\n" };
assert.deepEqual(api.validateOkfDocument(raw), { isValid: true, isIndexable: true, errors: [] });
const index = api.createOkfSearch([raw]);
assert.equal(index.search("release-raw-needle")[0]?.documentId, "raw");
assert.equal(index.ingest({ path: "added.md", markdown: "---\\ntype: added\\n---\\nrelease-added-needle\\n" }).conformance, "strict");
assert.deepEqual(index.listTypes(), ["added", "note"]);
assert.equal(index.remove("./added.md"), true);
assert.deepEqual(index.search("release-added-needle", { match: "all" }), []);
assert.throws(() => index.autoSuggest("release"), (error) => error instanceof api.OkfError && error.code === "ERR_OKF_UNSUPPORTED");
const fixture = join(process.cwd(), "fixture");
const source = join(fixture, "nested", "directory.md");
const before = await readFile(source, "utf8");
const opened = await api.openOkf(fixture);
assert.equal(opened.search("release-directory-needle")[0]?.path, "nested/directory.md");
assert.equal(opened.remove("nested/directory.md"), true);
assert.deepEqual(opened.search("release-directory-needle"), []);
assert.equal(await readFile(source, "utf8"), before);
`,
      "root.cjs": `const assert = require("node:assert/strict");
const api = require("okf-search-native");
assert.deepEqual(Object.keys(api).sort(), ["OkfError", "createOkfSearch", "openOkf", "validateOkfDocument"]);
const index = api.createOkfSearch([{ path: "cjs.md", markdown: "---\\ntype: cjs\\n---\\nrelease-cjs-needle\\n" }]);
assert.equal(index.search("release-cjs-needle").length, 1);
`,
      "prepared.mjs": `import assert from "node:assert/strict";
import { NativeOkfSearch } from "okf-search-native/prepared";
const section = { sectionId: "prepared#root", headingPath: "Prepared", text: "release-prepared-needle", startLine: 1, endLine: 3 };
const document = { documentId: "prepared", path: "prepared.md", type: "note", conformance: "strict", diagnostics: [], title: "Prepared", tags: ["release"], status: "stable", stalenessClassified: true, trustTier: "human-reviewed", resource: "prepared", description: "release fixture", sourceText: "", sections: [section] };
const index = NativeOkfSearch.fromPrepared([document]);
assert.equal(index.search("release-prepared-needle")[0]?.documentId, "prepared");
index.ingestPrepared({ ...document, type: "guide", sections: [{ ...section, text: "release-prepared-replacement" }] });
assert.deepEqual(index.listTypes(), ["guide"]);
assert.equal(index.removeDocument("prepared"), true);
assert.deepEqual(index.listTypes(), []);
assert.equal(index.removeDocument("prepared"), false);
assert.equal(index.removeDocument("missing"), false);
`,
      "prepared.cjs": `const assert = require("node:assert/strict");
const { NativeOkfSearch } = require("okf-search-native/prepared");
assert.deepEqual(NativeOkfSearch.fromPrepared([]).search("empty"), []);
`,
    }
    for (const [file, source] of Object.entries(entries)) await writeFile(join(root, file), source)
    for (const file of Object.keys(entries)) {
      run(process.execPath, [file], root, process.env, false, onCommand, runCommand)
    }

    if (typescript) {
      const types = `import { createOkfSearch, openOkf, type OkfSearch } from "okf-search-native";
import { NativeOkfSearch, type PreparedDocument } from "okf-search-native/prepared";
const handle: OkfSearch = createOkfSearch([]);
const opened: Promise<OkfSearch> = openOkf(".");
const prepared: PreparedDocument[] = [];
const native = NativeOkfSearch.fromPrepared(prepared);
void [handle, opened, native];
`
      await writeFile(join(root, "types.mts"), types)
      await writeFile(join(root, "types.cts"), types)
      await writeFile(join(root, "tsconfig.json"), `${JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: [],
        },
        include: ["types.mts", "types.cts"],
      }, null, 2)}\n`)
      run(process.execPath, [resolve(typescript), "--project", "tsconfig.json", "--pretty", "false"], root, process.env, false, onCommand, runCommand)
    }

    console.log(`verified clean scripts-disabled native consumer for ${dependency}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export async function verifyLocalNativeConsumer({ directory, plan, expectedCommit = plan.releaseCommit, typescript, onCommand, runCommand = spawnSync } = {}) {
  await verifyPublicationPlan({ directory, plan, expectedCommit })
  const entry = plan.packages.find(({ name }) => name === NATIVE_PACKAGE)
  assert.ok(entry, "native package is not selected in the publication plan")
  await verifyNativeConsumer(resolve(directory, entry.tarball), { typescript, onCommand, runCommand })
  return { name: entry.name, version: entry.version }
}

function parseTypescript(args) {
  if (args.length === 0) return null
  if (args.length === 2 && args[0] === "--typescript" && args[1]) return args[1]
  fail("--typescript requires one compiler entry path")
}

async function main() {
  const [mode, first, second, third, ...extra] = process.argv.slice(2)
  if (mode === "local-js" && first && second && third && extra.length === 0) {
    const directory = resolve(first)
    const plan = JSON.parse(await readFile(resolve(second), "utf8"))
    const verified = await verifyLocalJsConsumers({ directory, plan, expectedCommit: third })
    console.log(`verified ${verified.length} local scripts-disabled JS artifact(s)`)
    return
  }
  if (mode === "local-native" && first && second && third) {
    const directory = resolve(first)
    const plan = JSON.parse(await readFile(resolve(second), "utf8"))
    await verifyLocalNativeConsumer({
      directory,
      plan,
      expectedCommit: third,
      typescript: parseTypescript(extra),
    })
    return
  }
  fail("usage: verify-release-consumer.mjs local-js <artifact-directory> <plan.json> <release-commit> | local-native <artifact-directory> <plan.json> <release-commit> [--typescript <tsc-entry>]")
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
