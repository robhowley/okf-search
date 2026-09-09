#!/usr/bin/env node

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { expectedArtifactNames } from "../packages/okf-search-native/scripts/verify-release-artifacts.mjs"
import { packagePublicationPolicy } from "./npm-registry-state.mjs"
import { resolveCommandShape } from "./command-shape.mjs"
import { PUBLIC_PACKAGES } from "./release-candidates.mjs"

const TARGETS = [
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "x86_64-unknown-linux-gnu",
]

export const COMPRESSED_LIMIT = 12_000_000
export const UNPACKED_LIMIT = 32_000_000
export const NATIVE_ARTIFACTS = Object.freeze(expectedArtifactNames({ napi: { targets: TARGETS } }))
export const NATIVE_PACKAGE_FILES = Object.freeze([
  "LICENSE",
  "README.md",
  "dist/index.cjs",
  "dist/index.d.cts",
  "dist/index.d.mts",
  "dist/index.d.ts",
  "dist/index.mjs",
  "native.cjs",
  "native.d.cts",
  ...NATIVE_ARTIFACTS,
  "package.json",
])

const SHA = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const SRI = /^sha512-[A-Za-z0-9+/]{86}==$/
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const PACKAGE_BY_PATH = new Map(PUBLIC_PACKAGES.map((entry) => [entry.path, entry.name]))

function fail(message) {
  throw new Error(message)
}

function run(command, args, options = {}, runCommand = spawnSync) {
  const shape = resolveCommandShape(command, args)
  const result = runCommand(shape.command, shape.args, { encoding: "utf8", ...options })
  if (result.error) throw result.error
  if (result.status !== 0) fail(`${command} ${args.join(" ")} exited with ${result.status}${result.stderr ? `: ${result.stderr.trim()}` : ""}`)
  return result.stdout?.trim() ?? ""
}

export function runTar(tarball, operation, extraArgs = [], runCommand = spawnSync) {
  return run("tar", [operation, basename(tarball), ...extraArgs], { cwd: dirname(tarball) }, runCommand)
}

function digest(algorithm, bytes, encoding) {
  return createHash(algorithm).update(bytes).digest(encoding)
}

async function regularFiles(root, directory = root) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await regularFiles(root, path))
    } else {
      assert.equal(entry.isFile(), true, `publication artifact contains a non-regular entry: ${entry.name}`)
      files.push(path.slice(root.length + 1).replaceAll("\\", "/"))
    }
  }
  return files
}

function assertNativeManifest(manifest) {
  assert.equal(manifest.name, "okf-search-native", "native package name")
  assert.match(manifest.version ?? "", SEMVER, "native package version")
  assert.equal(manifest.private, undefined, "native package must not be private")
  assert.equal(manifest.type, undefined, "native package must not set a top-level type")
  assert.equal(manifest.main, "./dist/index.cjs")
  assert.equal(manifest.module, "./dist/index.mjs")
  assert.equal(manifest.types, "./dist/index.d.ts")
  assert.deepEqual(manifest.exports, {
    ".": {
      import: { types: "./dist/index.d.mts", default: "./dist/index.mjs" },
      require: { types: "./dist/index.d.cts", default: "./dist/index.cjs" },
      default: "./dist/index.mjs",
    },
    "./prepared": {
      types: "./native.d.cts",
      import: "./native.cjs",
      require: "./native.cjs",
      default: "./native.cjs",
    },
  })
  assert.deepEqual(manifest.files, ["dist", "native.cjs", "native.d.cts", "okf-search-native.*.node"])
  assert.equal(manifest.engines?.node, ">=22.19.0")
  assert.deepEqual(manifest.repository, {
    type: "git",
    url: "git+https://github.com/robhowley/okf-search.git",
    directory: "packages/okf-search-native",
  }, "native repository metadata")
  assert.equal(manifest.napi?.binaryName, "okf-search-native")
  assert.deepEqual(manifest.napi?.targets, TARGETS)
  assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0, "native package must have no runtime dependencies")
  assert.equal(Object.keys(manifest.optionalDependencies ?? {}).length, 0, "native package must have no optional dependencies")
  for (const lifecycle of ["preinstall", "install", "postinstall"]) {
    assert.equal(manifest.scripts?.[lifecycle], undefined, `native package contains ${lifecycle}`)
  }
  assert.equal(JSON.stringify(manifest).includes("workspace:"), false, "native manifest contains workspace:")
}

function validateSelection(selection, expectedCommit = selection?.commit) {
  assert.deepEqual(Object.keys(selection ?? {}).sort(), ["commit", "packages"], "release selection shape")
  assert.match(selection.commit ?? "", SHA, "release selection commit")
  assert.equal(selection.commit, expectedCommit, "release selection commit mismatch")
  assert.ok(Array.isArray(selection.packages) && selection.packages.length > 0, "release selection must contain packages")
  assert.equal(new Set(selection.packages.map(({ path }) => path)).size, selection.packages.length, "release selection contains duplicates")

  let previous = -1
  for (const selected of selection.packages) {
    assert.deepEqual(Object.keys(selected ?? {}).sort(), ["name", "path", "tag", "version"], "release package selection shape")
    const index = PUBLIC_PACKAGES.findIndex(({ path, name }) => path === selected.path && name === selected.name)
    assert.ok(index > previous, "release packages must follow the fixed dependency order")
    previous = index
    assert.match(selected.version ?? "", SEMVER, "release package version")
    assert.equal(selected.tag, `${selected.name}-v${selected.version}`, "release package tag mismatch")
  }
  return selection
}

export async function inspectPublicationArtifact(tarball, selected) {
  assert.equal(PACKAGE_BY_PATH.get(selected.path), selected.name, "publication artifact package path/name mismatch")
  assert.match(selected.version ?? "", SEMVER, "publication artifact version")
  const archive = await readFile(tarball)
  assert.ok(archive.length > 0, "publication artifact must not be empty")
  const listing = runTar(tarball, "-tzf").split(/\r?\n/).filter(Boolean)
  assert.ok(listing.length > 0, "publication artifact has no entries")
  for (const item of listing) {
    assert.ok(item === "package" || item === "package/" || item.startsWith("package/"), `publication artifact path escapes package/: ${item}`)
    assert.equal(item.split("/").includes(".."), false, `publication artifact path contains ..: ${item}`)
  }

  const extractionRoot = await mkdtemp(join(tmpdir(), "okf-publication-artifact-"))
  try {
    runTar(tarball, "-xzf", ["-C", extractionRoot])
    const packageRoot = join(extractionRoot, "package")
    const files = (await regularFiles(packageRoot)).sort()
    let unpackedBytes = 0
    for (const file of files) unpackedBytes += (await stat(join(packageRoot, file))).size
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
    assert.equal(manifest.name, selected.name, "publication artifact package name")
    assert.equal(manifest.version, selected.version, "publication artifact package version")

    const entry = {
      path: selected.path,
      name: selected.name,
      version: selected.version,
      releaseTag: selected.tag,
      tarball: basename(tarball),
      sha256: digest("sha256", archive, "hex"),
      integrity: `sha512-${digest("sha512", archive, "base64")}`,
      compressedBytes: archive.length,
      unpackedBytes,
    }
    if (selected.name === "okf-search-native") {
      assert.ok(archive.length <= COMPRESSED_LIMIT, `native compressed bytes ${archive.length} exceed ${COMPRESSED_LIMIT}`)
      assert.deepEqual(files, [...NATIVE_PACKAGE_FILES], "native files must match the exact release package")
      assert.ok(unpackedBytes <= UNPACKED_LIMIT, `native unpacked bytes ${unpackedBytes} exceed ${UNPACKED_LIMIT}`)
      assertNativeManifest(manifest)
      for (const native of NATIVE_ARTIFACTS) {
        assert.ok((await stat(join(packageRoot, native))).size > 0, `${native} must not be empty`)
      }
      entry.native = {
        artifacts: [...NATIVE_ARTIFACTS],
        packageFiles: [...NATIVE_PACKAGE_FILES],
        manifest,
        limits: { compressedBytes: COMPRESSED_LIMIT, unpackedBytes: UNPACKED_LIMIT },
      }
    }
    return entry
  } finally {
    await rm(extractionRoot, { recursive: true, force: true })
  }
}

function assertPlanEntry(entry) {
  const native = entry.name === "okf-search-native"
  assert.deepEqual(Object.keys(entry ?? {}).sort(), [
    "compressedBytes", "distTag", "integrity", "name", ...(native ? ["native"] : []), "path",
    "releaseTag", "sha256", "tarball", "unpackedBytes", "version",
  ].sort(), "publication plan entry shape")
  assert.equal(PACKAGE_BY_PATH.get(entry.path), entry.name, "publication plan package path/name mismatch")
  assert.match(entry.version ?? "", SEMVER)
  assert.equal(entry.releaseTag, `${entry.name}-v${entry.version}`)
  assert.match(entry.sha256 ?? "", SHA256)
  assert.match(entry.integrity ?? "", SRI)
  assert.ok(Number.isSafeInteger(entry.compressedBytes) && entry.compressedBytes > 0)
  assert.ok(Number.isSafeInteger(entry.unpackedBytes) && entry.unpackedBytes > 0)
  assert.ok(entry.distTag === "latest" || entry.distTag === null, "publication plan dist-tag policy")
  assert.equal(basename(entry.tarball ?? ""), entry.tarball, "publication plan tarball must be a filename")
  if (native) {
    assert.deepEqual(Object.keys(entry.native ?? {}).sort(), ["artifacts", "limits", "manifest", "packageFiles"])
    assert.deepEqual(entry.native.artifacts, [...NATIVE_ARTIFACTS])
    assert.deepEqual(entry.native.packageFiles, [...NATIVE_PACKAGE_FILES])
    assert.deepEqual(entry.native.limits, { compressedBytes: COMPRESSED_LIMIT, unpackedBytes: UNPACKED_LIMIT })
    assertNativeManifest(entry.native.manifest)
  }
}

export async function verifyPublicationPlan({ directory, plan, expectedSelection, expectedCommit }) {
  assert.deepEqual(Object.keys(plan ?? {}).sort(), ["packages", "releaseCommit", "schemaVersion"])
  assert.equal(plan.schemaVersion, 1)
  assert.match(plan.releaseCommit ?? "", SHA, "publication plan release commit")
  assert.equal(plan.releaseCommit, expectedCommit, "publication plan release commit mismatch")
  assert.ok(Array.isArray(plan.packages) && plan.packages.length > 0, "publication plan must contain selected packages")
  assert.equal(new Set(plan.packages.map(({ name }) => name)).size, plan.packages.length, "publication plan contains duplicate packages")

  const selection = expectedSelection ?? {
    commit: expectedCommit,
    packages: plan.packages.map(({ path, name, version, releaseTag: tag }) => ({ path, name, version, tag })),
  }
  validateSelection(selection, expectedCommit)
  assert.deepEqual(
    plan.packages.map(({ path, name, version, releaseTag: tag }) => ({ path, name, version, tag })),
    selection.packages,
    "publication plan does not match release selection",
  )

  const tarballs = new Set()
  for (const entry of plan.packages) {
    assertPlanEntry(entry)
    assert.equal(tarballs.has(entry.tarball), false, "publication plan contains duplicate tarballs")
    tarballs.add(entry.tarball)
    const selected = { path: entry.path, name: entry.name, version: entry.version, tag: entry.releaseTag, releaseCommit: plan.releaseCommit }
    const actual = await inspectPublicationArtifact(join(directory, entry.tarball), selected)
    assert.deepEqual({ ...actual, distTag: entry.distTag }, entry, `${entry.name}@${entry.version} publication artifact bytes changed`)
  }

  const names = (await readdir(directory, { withFileTypes: true })).map((entry) => {
    assert.equal(entry.isFile(), true, `publication plan directory contains non-file ${entry.name}`)
    return entry.name
  }).sort()
  assert.deepEqual(names, ["plan.json", ...tarballs].sort(), "publication plan directory has missing or unrecorded files")
  return plan
}

export async function createPublicationPlan({ directory, selection, releaseCommit = selection?.commit, registry = {} }) {
  validateSelection(selection, releaseCommit)
  const policy = registry.policy ?? packagePublicationPolicy
  const packages = []
  for (const selected of selection.packages) {
    const tarball = join(directory, `${selected.name}-${selected.version}.tgz`)
    const artifact = await inspectPublicationArtifact(tarball, { ...selected, releaseCommit })
    const publication = await policy(selected.name, selected.version)
    assert.ok(publication && ["published", "unpublished"].includes(publication.state), "registry publication state")
    assert.ok(publication.distTag === "latest" || publication.distTag === null, "registry dist-tag policy")
    packages.push({ ...artifact, distTag: publication.distTag })
  }
  const plan = { schemaVersion: 1, releaseCommit, packages }
  await writeFile(join(directory, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" })
  await verifyPublicationPlan({ directory, plan, expectedSelection: selection, expectedCommit: releaseCommit })
  return plan
}

function assertNpmVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? "")
  assert.ok(match, "npm version is malformed")
  const [major, minor, patch] = match.slice(1).map(Number)
  assert.ok(major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1))), "npm 11.5.1+ is required")
}

export function productionAdapters(runCommand = spawnSync) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm"
  return {
    registry: { policy: packagePublicationPolicy },
    npmVersion: async () => run(npm, ["--version"], {}, runCommand),
    publish: async (tarball, distTag) => {
      run(npm, ["publish", tarball, "--access", "public", "--provenance", "--tag", distTag], { stdio: "inherit" }, runCommand)
    },
  }
}

export async function runPublicationTransaction({
  directory,
  plan,
  expectedSelection,
  environment = process.env,
  registry,
  npmVersion,
  publish,
}) {
  const production = productionAdapters()
  registry ??= production.registry
  npmVersion ??= production.npmVersion
  publish ??= production.publish

  await verifyPublicationPlan({ directory, plan, expectedSelection, expectedCommit: expectedSelection.commit })
  assert.equal(environment.GITHUB_SHA, plan.releaseCommit, "workflow release commit mismatch")
  assert.equal(environment.GITHUB_REF, "refs/heads/main", "publication must run from main")
  assertNpmVersion(await npmVersion())

  const preflight = []
  for (const entry of plan.packages) {
    const policy = await registry.policy(entry.name, entry.version)
    assert.ok(["published", "unpublished"].includes(policy.state), `${entry.name} registry publication state is invalid`)
    assert.equal(policy.distTag, entry.distTag, `${entry.name} registry dist-tag policy changed`)
    preflight.push({ entry, state: policy.state })
  }

  for (const item of preflight) {
    if (item.state === "published") continue
    const policy = await registry.policy(item.entry.name, item.entry.version)
    assert.ok(["published", "unpublished"].includes(policy.state), `${item.entry.name} registry publication state is invalid`)
    assert.equal(policy.distTag, item.entry.distTag, `${item.entry.name} registry dist-tag policy changed`)
    if (policy.state === "published") continue
    assert.equal(item.entry.distTag, "latest", "missing versions require the latest tag")
    await publish(join(directory, item.entry.tarball), item.entry.distTag, item.entry)
  }

  return plan.packages.map(({ name, version }) => ({ name, version }))
}

async function main() {
  const [mode, directoryArgument, firstArgument, secondArgument, thirdArgument, ...extra] = process.argv.slice(2)
  const usage = "usage: release-publication.mjs create <directory> <selection.json> <release-commit> <plan.json> | transact <directory> <plan.json> <selection.json>"
  if (mode === "create") {
    if (!directoryArgument || !firstArgument || !secondArgument || !thirdArgument || extra.length) fail(usage)
    const directory = resolve(directoryArgument)
    const selection = JSON.parse(await readFile(resolve(firstArgument), "utf8"))
    const output = resolve(thirdArgument)
    assert.equal(output, join(directory, "plan.json"), "publication plan must be plan.json in the artifact directory")
    const plan = await createPublicationPlan({ directory, selection, releaseCommit: secondArgument })
    console.log(`created one immutable publication plan for ${plan.packages.length} package(s)`)
    return
  }
  if (mode === "transact") {
    if (!directoryArgument || !firstArgument || !secondArgument || thirdArgument !== undefined || extra.length) fail(usage)
    const directory = resolve(directoryArgument)
    const plan = JSON.parse(await readFile(resolve(firstArgument), "utf8"))
    const selection = JSON.parse(await readFile(resolve(secondArgument), "utf8"))
    await runPublicationTransaction({ directory, plan, expectedSelection: selection })
    console.log(`published ${plan.packages.length} immutable publication artifact(s)`)
    return
  }
  fail(usage)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
