#!/usr/bin/env node

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { expectedArtifactNames } from "../packages/okf-search-native/scripts/verify-release-artifacts.mjs"
import { NPM_REGISTRY, packagePublicationPolicy } from "./npm-registry-state.mjs"
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
export const NPM_OWNER = "robhowley"
export const SOURCE_REPOSITORY = "https://github.com/robhowley/okf-search"
export const PUBLICATION_WORKFLOW = ".github/workflows/release-please.yml"
export const PROVENANCE_PREDICATE = "https://slsa.dev/provenance/v1"
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
const STATEMENT_TYPE = "https://in-toto.io/Statement/v1"
const WORKFLOW_BUILD_TYPE = "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1"
const BUNDLE_MEDIA_TYPE = "application/vnd.dev.sigstore.bundle.v0.3+json"
const BUILDER = "https://github.com/actions/runner/github-hosted"

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

async function get(url, accept, fetchImpl) {
  let response
  try {
    response = await fetchImpl(url, { headers: { accept }, redirect: "error" })
  } catch (error) {
    fail(`request failed for ${url}: ${error instanceof Error ? error.message : error}`)
  }
  if (response.status !== 200) fail(`request for ${url} returned HTTP ${response.status}`)
  return response
}

async function responseJson(response, context) {
  try {
    const value = await response.json()
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${context} is malformed`)
    return value
  } catch (error) {
    if (error instanceof Error && error.message === `${context} is malformed`) throw error
    fail(`${context} returned malformed JSON`)
  }
}

function decodePayload(value) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail("provenance payload is not canonical base64")
  try {
    const payload = JSON.parse(Buffer.from(value, "base64").toString("utf8"))
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("provenance payload is malformed")
    return payload
  } catch (error) {
    if (error instanceof Error && error.message === "provenance payload is malformed") throw error
    fail("provenance payload is not valid JSON")
  }
}

function sha512Hex(integrity) {
  assert.match(integrity ?? "", SRI, "publication integrity")
  return Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex")
}

export function verifyProvenance(attestations, entry, { repository = SOURCE_REPOSITORY, workflow = PUBLICATION_WORKFLOW, releaseCommit }) {
  assert.ok(attestations && typeof attestations === "object" && !Array.isArray(attestations), "attestation response is malformed")
  assert.ok(Array.isArray(attestations.attestations), "attestation response has no attestations array")
  const matches = attestations.attestations.filter((item) => item?.predicateType === PROVENANCE_PREDICATE)
  assert.equal(matches.length, 1, "expected exactly one supported provenance attestation")
  const bundle = matches[0].bundle
  assert.equal(bundle?.mediaType, BUNDLE_MEDIA_TYPE, "unsupported provenance bundle schema")
  assert.match(bundle?.verificationMaterial?.certificate?.rawBytes ?? "", /^[A-Za-z0-9+/]+={0,2}$/, "provenance certificate is missing")
  assert.ok(Array.isArray(bundle?.verificationMaterial?.tlogEntries) && bundle.verificationMaterial.tlogEntries.length > 0, "provenance transparency log proof is missing")
  assert.equal(bundle?.dsseEnvelope?.payloadType, "application/vnd.in-toto+json")
  assert.ok(Array.isArray(bundle?.dsseEnvelope?.signatures) && bundle.dsseEnvelope.signatures.length > 0, "provenance signature is missing")
  const statement = decodePayload(bundle.dsseEnvelope.payload)
  assert.equal(statement._type, STATEMENT_TYPE)
  assert.equal(statement.predicateType, PROVENANCE_PREDICATE)
  assert.deepEqual(statement.subject, [{
    name: `pkg:npm/${entry.name}@${entry.version}`,
    digest: { sha512: sha512Hex(entry.integrity) },
  }], "provenance subject does not match publication entry")
  const build = statement.predicate?.buildDefinition
  assert.equal(build?.buildType, WORKFLOW_BUILD_TYPE)
  assert.deepEqual(build?.externalParameters?.workflow, { ref: "refs/heads/main", repository, path: workflow }, "provenance workflow identity does not match")
  assert.equal(statement.predicate?.runDetails?.builder?.id, BUILDER)
  assert.match(statement.predicate?.runDetails?.metadata?.invocationId ?? "", new RegExp(`^${repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/actions/runs/[0-9]+/attempts/[0-9]+$`), "provenance invocation identity does not match")
  assert.ok(Array.isArray(build?.resolvedDependencies), "provenance resolvedDependencies is missing")
  assert.equal(build.resolvedDependencies.some((dependency) => dependency?.uri === `git+${repository}@refs/heads/main` && dependency?.digest?.gitCommit === releaseCommit), true, "provenance release commit does not match")
}

export async function verifyNpmPublication(entry, { distTag = entry.distTag, releaseCommit, fetchImpl = fetch } = {}) {
  assertPlanEntry(entry)
  const encodedName = encodeURIComponent(entry.name)
  const packument = await responseJson(await get(`${NPM_REGISTRY}/${encodedName}`, "application/json", fetchImpl), `${entry.name} packument`)
  assert.equal(packument.name, entry.name, "registry package name does not match")
  if (distTag !== null) {
    assert.equal(packument["dist-tags"]?.[distTag], entry.version, `${distTag} dist-tag does not match`)
  } else {
    assert.notEqual(packument["dist-tags"]?.latest, entry.version, "historical publication unexpectedly owns latest")
  }
  assert.equal(Array.isArray(packument.maintainers) && packument.maintainers.some(({ name }) => name === NPM_OWNER), true, "npm owner does not match")
  const version = packument.versions?.[entry.version]
  assert.ok(version && typeof version === "object" && !Array.isArray(version), "exact registry version is missing")
  assert.equal(version.name, entry.name)
  assert.equal(version.version, entry.version)
  assert.equal(version.dist?.integrity, entry.integrity, "registry integrity does not match publication entry")
  assert.match(version.dist?.tarball ?? "", /^https:\/\/registry\.npmjs\.org\//)
  const registryBytes = Buffer.from(await (await get(version.dist.tarball, "application/octet-stream", fetchImpl)).arrayBuffer())
  assert.equal(digest("sha256", registryBytes, "hex"), entry.sha256, "registry tarball SHA-256 does not match publication entry")
  assert.equal(`sha512-${digest("sha512", registryBytes, "base64")}`, entry.integrity, "registry tarball SRI does not match publication entry")
  const attestationUrl = `${NPM_REGISTRY}/-/npm/v1/attestations/${entry.name}@${entry.version}`
  assert.equal(version.dist?.attestations?.url, attestationUrl, "registry provenance URL does not match")
  assert.equal(version.dist?.attestations?.provenance?.predicateType, PROVENANCE_PREDICATE, "registry provenance predicate does not match")
  const attestations = await responseJson(await get(attestationUrl, "application/json", fetchImpl), `${entry.name} provenance`)
  verifyProvenance(attestations, entry, { releaseCommit })
  return { name: entry.name, version: entry.version, sha256: entry.sha256 }
}

async function verifyRegistrySignatures(entry, runCommand = spawnSync) {
  const root = await mkdtemp(join(tmpdir(), "okf-publication-signatures-"))
  const npm = process.platform === "win32" ? "npm.cmd" : "npm"
  try {
    await writeFile(join(root, "package.json"), `${JSON.stringify({ name: "okf-publication-signature-verifier", version: "1.0.0", private: true, dependencies: { [entry.name]: entry.version } }, null, 2)}\n`)
    run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--registry", NPM_REGISTRY], { cwd: root, stdio: "inherit" }, runCommand)
    run(npm, ["audit", "signatures", "--registry", NPM_REGISTRY], { cwd: root, stdio: "inherit" }, runCommand)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function packageOwnerState(name, fetchImpl = fetch) {
  const response = await fetchImpl(`${NPM_REGISTRY}/${encodeURIComponent(name)}`, { headers: { accept: "application/json" }, redirect: "error" })
  if (response.status === 404) return "missing"
  if (response.status !== 200) fail(`npm owner lookup for ${name} returned HTTP ${response.status}`)
  const packument = await responseJson(response, `${name} packument`)
  assert.equal(packument.name, name, "registry package name does not match")
  assert.equal(Array.isArray(packument.maintainers) && packument.maintainers.some(({ name: owner }) => owner === NPM_OWNER), true, "npm owner does not match")
  return "owned"
}

function assertNpmVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? "")
  assert.ok(match, "npm version is malformed")
  const [major, minor, patch] = match.slice(1).map(Number)
  assert.ok(major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1))), "npm 11.5.1+ is required")
}

export function verifyOidcToken(token, { repository, ref, workflow, commit }) {
  assert.equal(typeof token, "string", "OIDC token is missing")
  const parts = token.split(".")
  assert.equal(parts.length, 3, "OIDC token is malformed")
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
  assert.equal(payload.aud, "npm:registry.npmjs.org", "OIDC audience mismatch")
  assert.equal(payload.repository, repository, "OIDC repository mismatch")
  assert.equal(payload.ref, ref, "OIDC ref mismatch")
  assert.ok(payload.workflow_ref?.startsWith(`${repository}/${workflow}@`), "OIDC workflow mismatch")
  assert.equal(payload.sha, commit, "OIDC provenance commit mismatch")
}

export function productionAdapters(environment, runCommand = spawnSync) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm"
  return {
    registry: {
      policy: packagePublicationPolicy,
      owner: packageOwnerState,
      verify: async (entry, plan) => {
        const result = await verifyNpmPublication(entry, { distTag: entry.distTag, releaseCommit: plan.releaseCommit })
        await verifyRegistrySignatures(entry, runCommand)
        return result
      },
      ping: async () => { run(npm, ["ping", `--registry=${NPM_REGISTRY}`], { stdio: "inherit" }, runCommand) },
    },
    npmVersion: async () => run(npm, ["--version"], {}, runCommand),
    getOidc: async () => {
      assert.ok(environment.ACTIONS_ID_TOKEN_REQUEST_URL, "GitHub OIDC request URL is missing")
      assert.ok(environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN, "GitHub OIDC request token is missing")
      const separator = environment.ACTIONS_ID_TOKEN_REQUEST_URL.includes("?") ? "&" : "?"
      const response = await fetch(`${environment.ACTIONS_ID_TOKEN_REQUEST_URL}${separator}audience=npm:registry.npmjs.org`, { headers: { authorization: `Bearer ${environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } })
      if (!response.ok) fail(`GitHub OIDC request returned HTTP ${response.status}`)
      return (await response.json()).value
    },
    publish: async (tarball, distTag) => {
      run(npm, ["publish", tarball, "--access", "public", "--provenance", "--tag", distTag], { stdio: "inherit" }, runCommand)
    },
  }
}

async function retryProof(entry, plan, verify, sleep, attempts) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await verify(entry, plan)
    } catch (error) {
      lastError = error
      if (attempt < attempts) await sleep(attempt * 10_000)
    }
  }
  throw lastError
}

export async function runPublicationTransaction({
  directory,
  plan,
  expectedSelection,
  environment = process.env,
  registry,
  npmVersion,
  getOidc,
  publish,
  sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
  proofAttempts = 6,
}) {
  const production = productionAdapters(environment)
  registry ??= production.registry
  npmVersion ??= production.npmVersion
  getOidc ??= production.getOidc
  publish ??= production.publish

  assert.ok(Number.isSafeInteger(proofAttempts) && proofAttempts > 0, "proof attempts must be a positive integer")
  await verifyPublicationPlan({ directory, plan, expectedSelection, expectedCommit: expectedSelection.commit })
  assert.equal(environment.GITHUB_SHA, plan.releaseCommit, "workflow release commit mismatch")
  assert.equal(environment.GITHUB_REF, "refs/heads/main", "publication must run from main")
  assertNpmVersion(await npmVersion())
  await registry.ping()

  const preflight = []
  for (const entry of plan.packages) {
    const policy = await registry.policy(entry.name, entry.version)
    assert.ok(["published", "unpublished"].includes(policy.state), `${entry.name} registry publication state is invalid`)
    assert.equal(policy.distTag, entry.distTag, `${entry.name} registry dist-tag policy changed`)
    const owner = await registry.owner(entry.name)
    if (owner !== "owned" && owner !== "missing") fail(`${entry.name} owner state is invalid`)
    if (owner === "missing" && policy.state !== "unpublished") fail(`${entry.name} published version has no owner record`)
    if (policy.state === "published") await registry.verify(entry, plan)
    preflight.push({ entry, state: policy.state, owner })
  }

  const missing = preflight.filter(({ state }) => state === "unpublished")
  if (missing.length > 0) {
    const token = await getOidc()
    verifyOidcToken(token, {
      repository: "robhowley/okf-search",
      ref: "refs/heads/main",
      workflow: PUBLICATION_WORKFLOW,
      commit: plan.releaseCommit,
    })
  }

  for (const item of preflight) {
    if (item.state === "published") continue
    const policy = await registry.policy(item.entry.name, item.entry.version)
    assert.ok(["published", "unpublished"].includes(policy.state), `${item.entry.name} registry publication state is invalid`)
    assert.equal(policy.distTag, item.entry.distTag, `${item.entry.name} registry dist-tag policy changed`)
    if (policy.state === "published") {
      await registry.verify(item.entry, plan)
      continue
    }
    const owner = await registry.owner(item.entry.name)
    assert.ok(owner === "owned" || owner === "missing", `${item.entry.name} owner state is invalid`)
    assert.equal(owner, item.owner, `${item.entry.name} npm ownership changed after preflight`)
    assert.equal(item.entry.distTag, "latest", "missing versions require the latest tag")
    await publish(join(directory, item.entry.tarball), item.entry.distTag, item.entry)
    await retryProof(item.entry, plan, registry.verify, sleep, proofAttempts)
  }

  for (const entry of plan.packages) await registry.verify(entry, plan)
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
    console.log(`published/proved ${plan.packages.length} immutable publication artifact(s)`)
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
