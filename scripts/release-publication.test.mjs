import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, isAbsolute, join, resolve } from "node:path"
import test from "node:test"

import { PUBLIC_PACKAGES, resolveTagCommit, selectReleaseCandidates } from "./release-candidates.mjs"
import { compareSemver, NPM_REGISTRY, packagePublicationPolicy } from "./npm-registry-state.mjs"
import {
  COMPRESSED_LIMIT,
  NATIVE_ARTIFACTS,
  NATIVE_PACKAGE_FILES,
  UNPACKED_LIMIT,
  createPublicationPlan,
  inspectPublicationArtifact,
  productionAdapters,
  runPublicationTransaction,
  runTar,
  verifyPublicationPlan,
} from "./release-publication.mjs"
import { resolveCommandShape } from "./command-shape.mjs"
import { pnpmCommand, run as runPackageCommand } from "./check-package.mjs"
import {
  verifyLocalJsConsumers,
  verifyLocalNativeConsumer,
  verifyNativeConsumer,
} from "./verify-release-consumer.mjs"

const fixture = JSON.parse(readFileSync(new URL("./fixtures/release-publication.json", import.meta.url)))
const releaseCommit = "a".repeat(40)

function candidateAdapters({ tags = {}, releases = {}, manifests = fixture.manifests } = {}) {
  return {
    readManifest: async (_commit, path) => manifests[path] ?? null,
    resolveTag: async (tag) => tags[tag] ?? null,
    getRelease: async (tag) => releases[tag] ?? null,
  }
}

function githubRelease(tag, draft = false) {
  return { tag_name: tag, draft }
}

test("release selection keeps the fixed public-package order", async () => {
  const tags = {
    "okf-minisearch-v2.3.0": fixture.commit,
    "pi-okf-search-v0.5.0": fixture.commit,
    "okf-search-native-v0.1.0": fixture.commit,
  }
  const releases = Object.fromEntries(Object.keys(tags).map((tag) => [tag, githubRelease(tag)]))
  const result = await selectReleaseCandidates({
    eventName: "push",
    eventCommit: fixture.commit,
    releaseTag: "",
    ...candidateAdapters({ tags, releases }),
  })
  assert.deepEqual(result.packages.map(({ path }) => path), ["packages/okf-minisearch", "packages/okf-search-native", "packages/pi-okf-search"])
})

test("dispatch requires an exact non-draft allowlisted release", async () => {
  const tag = "okf-minisearch-v2.3.0"
  await assert.rejects(selectReleaseCandidates({
    eventName: "workflow_dispatch",
    releaseTag: tag,
    ...candidateAdapters({ tags: { [tag]: fixture.commit }, releases: { [tag]: githubRelease(tag, true) } }),
  }), /draft/)
})

test("tag resolution peels lightweight and annotated tags", () => {
  const cwd = mkdtempSync(join(tmpdir(), "release-tags-"))
  try {
    execFileSync("git", ["init", "--quiet"], { cwd })
    execFileSync("git", ["config", "user.email", "release-test@example.com"], { cwd })
    execFileSync("git", ["config", "user.name", "Release Test"], { cwd })
    execFileSync("git", ["commit", "--quiet", "--allow-empty", "-m", "fixture"], { cwd })
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim()
    execFileSync("git", ["tag", "lightweight"], { cwd })
    execFileSync("git", ["tag", "-a", "annotated", "-m", "fixture tag"], { cwd })
    assert.equal(resolveTagCommit("lightweight", cwd), commit)
    assert.equal(resolveTagCommit("annotated", cwd), commit)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("numeric prerelease identifiers compare exactly at arbitrary length", () => {
  assert.ok(compareSemver("2.3.0-beta.9007199254740993", "2.3.0-beta.9007199254740992") > 0)
  assert.ok(compareSemver("2.3.0-beta.100000000000000000000000000000000000001", "2.3.0-beta.99999999999999999999999999999999999999") > 0)
  assert.equal(compareSemver("2.3.0-beta.100000000000000000000", "2.3.0-beta.100000000000000000000"), 0)
})

test("registry policy preserves stable, prerelease, new-package, and historical latest rules", async (t) => {
  const fetchPackument = (packument, status = 200) => async (url, options) => {
    assert.equal(url, `${NPM_REGISTRY}/okf-minisearch`)
    assert.equal(options.redirect, "error")
    return { status, json: async () => packument }
  }
  for (const [label, version, latest] of [
    ["stable upgrade", "2.3.0", "2.2.1"],
    ["prerelease upgrade", "2.3.0-beta.2", "2.3.0-beta.1"],
  ]) {
    await t.test(label, async () => {
      assert.deepEqual(
        await packagePublicationPolicy("okf-minisearch", version, fetchPackument({ name: "okf-minisearch", "dist-tags": { latest }, versions: {} })),
        { state: "unpublished", distTag: "latest" },
      )
    })
  }
  await t.test("new package", async () => {
    assert.deepEqual(
      await packagePublicationPolicy("okf-minisearch", "2.3.0", fetchPackument({}, 404)),
      { state: "unpublished", distTag: "latest" },
    )
  })
  await t.test("unpublished historical version", async () => {
    await assert.rejects(
      packagePublicationPolicy("okf-minisearch", "2.3.0", fetchPackument({ name: "okf-minisearch", "dist-tags": { latest: "2.4.0" }, versions: {} })),
      /latest is newer/,
    )
  })
  await t.test("published historical version", async () => {
    assert.deepEqual(
      await packagePublicationPolicy("okf-minisearch", "2.3.0", fetchPackument({
        name: "okf-minisearch",
        "dist-tags": { latest: "2.4.0" },
        versions: { "2.3.0": { name: "okf-minisearch", version: "2.3.0" } },
      })),
      { state: "published", distTag: null },
    )
  })
  await t.test("published latest version", async () => {
    assert.deepEqual(
      await packagePublicationPolicy("okf-minisearch", "2.3.0", fetchPackument({
        name: "okf-minisearch",
        "dist-tags": { latest: "2.3.0" },
        versions: { "2.3.0": { name: "okf-minisearch", version: "2.3.0" } },
      })),
      { state: "published", distTag: "latest" },
    )
  })
})

test("registry policy rejects a huge numeric prerelease rollback", async () => {
  const latest = "2.3.0-beta.9007199254740993"
  await assert.rejects(packagePublicationPolicy("okf-minisearch", "2.3.0-beta.9007199254740992", async () => ({
    status: 200,
    json: async () => ({ name: "okf-minisearch", "dist-tags": { latest }, versions: {} }),
  })), /latest is newer/)
})

function nativeManifest(overrides = {}) {
  return {
    name: "okf-search-native",
    version: "0.1.0",
    description: "fixture",
    main: "./dist/index.cjs",
    module: "./dist/index.mjs",
    types: "./dist/index.d.ts",
    exports: {
      ".": {
        import: { types: "./dist/index.d.mts", default: "./dist/index.mjs" },
        require: { types: "./dist/index.d.cts", default: "./dist/index.cjs" },
        default: "./dist/index.mjs",
      },
      "./prepared": { types: "./native.d.cts", import: "./native.cjs", require: "./native.cjs", default: "./native.cjs" },
    },
    files: ["dist", "native.cjs", "native.d.cts", "okf-search-native.*.node"],
    scripts: { test: "node --test" },
    devDependencies: { typescript: "1.0.0" },
    engines: { node: ">=22.19.0" },
    license: "MIT",
    repository: { type: "git", url: "git+https://github.com/robhowley/okf-search.git", directory: "packages/okf-search-native" },
    napi: { binaryName: "okf-search-native", targets: ["x86_64-apple-darwin", "aarch64-apple-darwin", "x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"] },
    ...overrides,
  }
}

function packTarball(directory, name, version, manifest, files = { "index.js": "export const marker = 'selected-bytes'\n" }) {
  const staging = mkdtempSync(join(tmpdir(), "release-package-"))
  const packageRoot = join(staging, "package")
  mkdirSync(packageRoot, { recursive: true })
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify(manifest))
  for (const [file, contents] of Object.entries(files)) {
    const path = join(packageRoot, file)
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, contents)
  }
  const tarball = join(directory, `${name}-${version}.tgz`)
  execFileSync("tar", ["-czf", tarball, "package"], { cwd: staging })
  rmSync(staging, { recursive: true, force: true })
  return tarball
}

function packNative(directory, { manifest = nativeManifest(), tarballVersion = "0.1.0", omit, empty, contents = {}, extra = {} } = {}) {
  const files = { ...extra }
  for (const file of NATIVE_PACKAGE_FILES) {
    if (file === "package.json" || file === omit) continue
    files[file] = file === empty ? "" : contents[file] ?? `fixture:${file}`
  }
  return packTarball(directory, "okf-search-native", tarballVersion, manifest, files)
}

function packWorkspacePackage(directory, packagePath) {
  const packageRoot = resolve(packagePath)
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"))
  const output = JSON.parse(execFileSync("pnpm", ["pack", "--pack-destination", directory, "--json"], {
    cwd: packageRoot,
    encoding: "utf8",
  }))
  const source = isAbsolute(output.filename) ? output.filename : resolve(packageRoot, output.filename)
  const target = join(directory, `${manifest.name}-${manifest.version}.tgz`)
  if (source !== target) renameSync(source, target)
  return packageSpec(manifest.name, manifest.version)
}

function rewriteTarballManifest(tarball, mutate) {
  const staging = mkdtempSync(join(tmpdir(), "rewrite-release-package-"))
  try {
    execFileSync("tar", ["-xzf", tarball, "-C", staging])
    const path = join(staging, "package", "package.json")
    const manifest = JSON.parse(readFileSync(path, "utf8"))
    mutate(manifest)
    writeFileSync(path, JSON.stringify(manifest))
    rmSync(tarball)
    execFileSync("tar", ["-czf", tarball, "package"], { cwd: staging })
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

function packRunnableNative(directory) {
  const packageRoot = resolve("packages/okf-search-native")
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"))
  const contents = {}

  for (const file of NATIVE_PACKAGE_FILES) {
    if (file === "package.json") continue
    const source = join(packageRoot, file)
    if (existsSync(source)) contents[file] = readFileSync(source)
  }

  packNative(directory, { manifest, tarballVersion: manifest.version, contents })
  return packageSpec(manifest.name, manifest.version)
}

function packWorkspacePackages(directory, { mini = true, native = false, pi = true } = {}) {
  const specs = []
  if (mini) specs.push(packWorkspacePackage(directory, "packages/okf-minisearch"))
  if (native) specs.push(packRunnableNative(directory))
  if (pi) specs.push(packWorkspacePackage(directory, "packages/pi-okf-search"))
  return specs
}

function selection(packages) {
  return {
    commit: releaseCommit,
    packages: packages.map(({ path, name, version }) => ({ path, name, version, tag: `${name}-v${version}` })),
  }
}

function packageSpec(name, version) {
  return PUBLIC_PACKAGES.find((entry) => entry.name === name) && {
    ...PUBLIC_PACKAGES.find((entry) => entry.name === name),
    version,
  }
}

test("successful inherited-stdio commands tolerate null stdout", () => {
  assert.equal(
    runTar("/tmp/release-package.tgz", "-tzf", [], () => ({ status: 0, stdout: null, stderr: null })),
    "",
  )
  assert.equal(
    runTar("/tmp/release-package.tgz", "-tzf", [], () => ({ status: 0, stdout: " package \n", stderr: "" })),
    "package",
  )
  assert.throws(
    () => runTar("/tmp/release-package.tgz", "-tzf", [], () => ({ status: 1, stdout: "partial\n", stderr: "tar failed\n" })),
    /exited with 1: tar failed/,
  )
})

test("Unix package-manager commands keep their command and argument shape", () => {
  const args = ["install", "release package/package.tgz", "--save-exact"]
  assert.deepEqual(resolveCommandShape("npm", args, { platform: "darwin", comSpec: "custom-cmd" }), {
    command: "npm",
    args,
  })
  assert.deepEqual(resolveCommandShape("pnpm", args, { platform: "linux", comSpec: "custom-cmd" }), {
    command: "pnpm",
    args,
  })
})

test("Windows batch commands use ComSpec or cmd.exe and preserve argument entries", () => {
  const args = ["install", "C:\\release package\\native.tgz", "--save-exact"]
  assert.deepEqual(resolveCommandShape("npm.cmd", args, {
    platform: "win32",
    comSpec: "C:\\Windows\\System32\\custom-cmd.exe",
  }), {
    command: "C:\\Windows\\System32\\custom-cmd.exe",
    args: ["/d", "/s", "/c", "npm.cmd", ...args],
  })
  assert.deepEqual(resolveCommandShape("pnpm.bat", args, { platform: "win32", comSpec: "" }), {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "pnpm.bat", ...args],
  })
  assert.deepEqual(resolveCommandShape("node", args, { platform: "win32", comSpec: "custom-cmd" }), {
    command: "node",
    args,
  })
})

test("release publication npm commands use the Windows ComSpec at their production boundary", async () => {
  const commands = []
  const tarball = join(tmpdir(), "release package.tgz")
  await withWindowsProcess(async () => {
    const adapters = productionAdapters((command, args, options) => {
      commands.push({ command, args: [...args], options })
      return { status: 0, stdout: null, stderr: null }
    })
    assert.equal(await adapters.npmVersion(), "")
    await adapters.publish(tarball, "latest")
  })

  assert.equal(commands.length, 2)
  assert.equal(commands.every(({ command }) => command === "C:\\Windows\\System32\\custom-cmd.exe"), true)
  assert.deepEqual(commands[0].args, ["/d", "/s", "/c", "npm.cmd", "--version"])
  assert.deepEqual(commands[1].args, ["/d", "/s", "/c", "npm.cmd", "publish", tarball, "--access", "public", "--provenance", "--tag", "latest"])
})

test("check-package pnpm launches use the Windows ComSpec at their production boundary", async () => {
  const commands = []
  const args = ["install", join(tmpdir(), "release package"), "--ignore-scripts"]
  await withWindowsProcess(async () => {
    const pnpm = pnpmCommand()
    assert.equal(pnpm, "pnpm.cmd")
    assert.equal(runPackageCommand(pnpm, args, { capture: true }, (command, forwardedArgs, options) => {
      commands.push({ command, args: [...forwardedArgs], options })
      return { status: 0, stdout: null, stderr: null }
    }), "")
  })

  assert.deepEqual(commands, [{
    command: "C:\\Windows\\System32\\custom-cmd.exe",
    args: ["/d", "/s", "/c", "pnpm.cmd", ...args],
    options: { cwd: workspaceRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  }])
})

test("tarball checks use a local basename for drive-like archive paths", () => {
  const tarball = "D:/a/_temp/publication-plan/okf-search-native-0.3.1.tgz"
  const commands = []
  const runCommand = (command, args, options) => {
    commands.push({ command, args, options })
    return { status: 0, stdout: "package\\n", stderr: "" }
  }

  runTar(tarball, "-tzf", [], runCommand)
  runTar(tarball, "-xzf", ["-C", "/tmp/extracted"], runCommand)

  assert.deepEqual(commands, [
    {
      command: "tar",
      args: ["-tzf", "okf-search-native-0.3.1.tgz"],
      options: { encoding: "utf8", cwd: "D:/a/_temp/publication-plan" },
    },
    {
      command: "tar",
      args: ["-xzf", "okf-search-native-0.3.1.tgz", "-C", "/tmp/extracted"],
      options: { encoding: "utf8", cwd: "D:/a/_temp/publication-plan" },
    },
  ])
  assert.equal(commands.every(({ args }) => !args[1].includes("D:")), true)
})

const workspaceRoot = resolve(".")

async function withWindowsProcess(callback) {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")
  const originalComSpec = process.env.ComSpec
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" })
  process.env.ComSpec = "C:\\Windows\\System32\\custom-cmd.exe"
  try {
    return await callback()
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor)
    if (originalComSpec === undefined) delete process.env.ComSpec
    else process.env.ComSpec = originalComSpec
  }
}

async function makePlan(specs, pack = () => {}, policy = async () => ({ state: "unpublished", distTag: "latest" })) {
  const directory = mkdtempSync(join(tmpdir(), "publication-plan-"))
  pack(directory)
  const selected = selection(specs)
  const plan = await createPublicationPlan({ directory, selection: selected, registry: { policy } })
  return { directory, selection: selected, plan }
}

test("one plan owns native identity, exact files, manifest, commit, sizes, and digests", async () => {
  const spec = packageSpec("okf-search-native", "0.1.0")
  const data = await makePlan([spec], (directory) => packNative(directory))
  try {
    const entry = data.plan.packages[0]
    assert.equal(data.plan.releaseCommit, releaseCommit)
    assert.deepEqual(entry.native.artifacts, [...NATIVE_ARTIFACTS])
    assert.deepEqual(entry.native.packageFiles, [...NATIVE_PACKAGE_FILES])
    assert.deepEqual(entry.native.manifest, nativeManifest())
    assert.deepEqual(entry.native.manifest.repository, nativeManifest().repository)
    assert.deepEqual(entry.native.limits, { compressedBytes: COMPRESSED_LIMIT, unpackedBytes: UNPACKED_LIMIT })
    const archive = readFileSync(join(data.directory, entry.tarball))
    assert.equal(entry.sha256, createHash("sha256").update(archive).digest("hex"))
    assert.equal(entry.integrity, `sha512-${createHash("sha512").update(archive).digest("base64")}`)
    assert.equal(entry.compressedBytes, archive.length)
    assert.equal(existsSync(join(data.directory, "plan.json")), true)
    assert.equal(existsSync(join(data.directory, "candidate.json")), false)
  } finally {
    rmSync(data.directory, { recursive: true, force: true })
  }
})

test("native plan owner rejects invalid package files, identity, manifest contract, and unpacked ceiling", async (t) => {
  const spec = packageSpec("okf-search-native", "0.1.0")
  const wrongExports = structuredClone(nativeManifest().exports)
  wrongExports["."].import.default = "./dist/wrong.mjs"
  for (const [label, options, pattern] of [
    ["missing file", { omit: "dist/index.mjs" }, /exact release package/],
    ["extra file", { extra: { "unexpected.js": "bad" } }, /exact release package/],
    ["empty native", { empty: NATIVE_ARTIFACTS[0] }, /must not be empty/],
    ["package name", { manifest: nativeManifest({ name: "wrong" }) }, /package name/],
    ["package version", { manifest: nativeManifest({ version: "0.2.0" }) }, /package version/],
    ["private marker", { manifest: nativeManifest({ private: true }) }, /must not be private/],
    ["repository and package directory", { manifest: nativeManifest({ repository: { type: "git", url: "git+https://github.com/robhowley/okf-search.git", directory: "packages/wrong" } }) }, /repository metadata/],
    ["root entrypoints", { manifest: nativeManifest({ main: "./wrong.cjs", module: "./wrong.mjs", types: "./wrong.d.ts" }) }, /actual.*expected|strictEqual/],
    ["exports", { manifest: nativeManifest({ exports: wrongExports }) }, /strictly deep-equal/],
    ["packed file declarations", { manifest: nativeManifest({ files: ["dist"] }) }, /strictly deep-equal/],
    ["native binary identity", { manifest: nativeManifest({ napi: { ...nativeManifest().napi, binaryName: "wrong" } }) }, /actual.*expected|strictEqual/],
    ["native targets", { manifest: nativeManifest({ napi: { ...nativeManifest().napi, targets: nativeManifest().napi.targets.slice(1) } }) }, /strictly deep-equal/],
    ["runtime dependency", { manifest: nativeManifest({ dependencies: { bad: "1.0.0" } }) }, /runtime dependencies/],
    ["optional dependency", { manifest: nativeManifest({ optionalDependencies: { bad: "1.0.0" } }) }, /optional dependencies/],
    ["install lifecycle", { manifest: nativeManifest({ scripts: { install: "bad" } }) }, /contains install/],
    ["workspace marker", { manifest: nativeManifest({ devDependencies: { bad: "workspace:*" } }) }, /workspace:/],
  ]) {
    await t.test(label, async () => {
      const directory = mkdtempSync(join(tmpdir(), "native-rejection-"))
      try {
        packNative(directory, options)
        await assert.rejects(createPublicationPlan({ directory, selection: selection([spec]), registry: { policy: async () => ({ state: "unpublished", distTag: "latest" }) } }), pattern)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })
  }

  await t.test("fixed unpacked ceiling", async () => {
    const directory = mkdtempSync(join(tmpdir(), "native-unpacked-ceiling-"))
    try {
      packNative(directory, { manifest: nativeManifest({ description: "x".repeat(UNPACKED_LIMIT + 1) }) })
      await assert.rejects(createPublicationPlan({ directory, selection: selection([spec]), registry: { policy: async () => ({ state: "unpublished", distTag: "latest" }) } }), /unpacked bytes/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

test("native plan owner enforces the fixed compressed ceiling", async () => {
  const directory = mkdtempSync(join(tmpdir(), "native-compressed-ceiling-"))
  const spec = packageSpec("okf-search-native", "0.1.0")
  try {
    packNative(directory, { contents: { [NATIVE_ARTIFACTS[0]]: randomBytes(COMPRESSED_LIMIT + 1024) } })
    await assert.rejects(
      createPublicationPlan({ directory, selection: selection([spec]), registry: { policy: async () => ({ state: "unpublished", distTag: "latest" }) } }),
      /compressed bytes/,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("plan validator rejects shape, commit, ordering, membership, and malformed entries", async (t) => {
  const mini = packageSpec("okf-minisearch", "2.3.0")
  const pi = packageSpec("pi-okf-search", "0.5.0")
  const data = await makePlan([mini, pi], (directory) => {
    packTarball(directory, mini.name, mini.version, { name: mini.name, version: mini.version, type: "module" })
    packTarball(directory, pi.name, pi.version, { name: pi.name, version: pi.version, type: "module" })
  })
  try {
    const cases = [
      ["plan shape", (plan) => { plan.unexpected = true }, /publication plan.*shape|Expected values/],
      ["release commit shape", (plan) => { plan.releaseCommit = "short" }, /release commit/],
      ["release commit mismatch", () => {}, /release commit mismatch/, "b".repeat(40)],
      ["reordered selection", () => {}, /fixed dependency order|does not match/, releaseCommit, selection([pi, mini])],
      ["duplicate entry", (plan) => { plan.packages.push(structuredClone(plan.packages[0])) }, /duplicate packages/],
      ["omitted entry", (plan) => { plan.packages.pop() }, /does not match release selection/],
      ["unknown entry", (plan) => { plan.packages[0].path = "packages/unknown" }, /does not match release selection|path\/name mismatch/],
      ["entry shape", (plan) => { plan.packages[0].unexpected = true }, /entry shape|Expected values/],
      ["bad SHA-256", (plan) => { plan.packages[0].sha256 = "0" }, /did not match the regular expression/],
      ["bad SRI", (plan) => { plan.packages[0].integrity = "sha512-bad" }, /did not match the regular expression/],
      ["invalid compressed size", (plan) => { plan.packages[0].compressedBytes = 0 }, /false == true|compressed/],
      ["invalid unpacked size", (plan) => { plan.packages[0].unpackedBytes = -1 }, /false == true|unpacked/],
      ["unsafe tarball path", (plan) => { plan.packages[0].tarball = "../bad.tgz" }, /must be a filename/],
    ]
    for (const [label, mutate, pattern, expectedCommit = releaseCommit, expectedSelection = data.selection] of cases) {
      await t.test(label, async () => {
        const plan = structuredClone(data.plan)
        mutate(plan)
        await assert.rejects(
          verifyPublicationPlan({ directory: data.directory, plan, expectedSelection, expectedCommit }),
          pattern,
        )
      })
    }
  } finally {
    rmSync(data.directory, { recursive: true, force: true })
  }
})

test("plan validator rejects changed digest bytes and every unrecorded directory entry", async (t) => {
  const mini = packageSpec("okf-minisearch", "2.3.0")
  await t.test("changed tarball bytes", async () => {
    const data = await makePlan([mini], (directory) => packTarball(directory, mini.name, mini.version, { name: mini.name, version: mini.version }))
    try {
      writeFileSync(join(data.directory, data.plan.packages[0].tarball), "changed")
      await assert.rejects(verifyPublicationPlan({ directory: data.directory, plan: data.plan, expectedSelection: data.selection, expectedCommit: releaseCommit }))
    } finally {
      rmSync(data.directory, { recursive: true, force: true })
    }
  })
  await t.test("extra plan-directory file", async () => {
    const data = await makePlan([mini], (directory) => packTarball(directory, mini.name, mini.version, { name: mini.name, version: mini.version }))
    try {
      writeFileSync(join(data.directory, "unrecorded.txt"), "unexpected")
      await assert.rejects(
        verifyPublicationPlan({ directory: data.directory, plan: data.plan, expectedSelection: data.selection, expectedCommit: releaseCommit }),
        /missing or unrecorded files/,
      )
    } finally {
      rmSync(data.directory, { recursive: true, force: true })
    }
  })
})

test("real selected JS packages run both production smokes with scripts disabled", async () => {
  const directory = mkdtempSync(join(tmpdir(), "local-js-plan-"))
  try {
    const specs = packWorkspacePackages(directory, { native: true })
    const plan = await createPublicationPlan({ directory, selection: selection(specs), registry: { policy: async () => ({ state: "unpublished", distTag: "latest" }) } })
    const commands = []
    const result = await verifyLocalJsConsumers({
      directory,
      plan,
      expectedCommit: releaseCommit,
      onCommand: (command) => commands.push(command),
    })
    assert.deepEqual(
      result,
      specs
        .filter(({ name }) => name !== "okf-search-native")
        .map(({ name, version }) => ({ name, version })),
    )
    const installs = commands.filter(({ args }) => args[0] === "install")
    assert.equal(installs.length, 2)
    assert.equal(installs.every(({ args }) => args.includes("--ignore-scripts")), true)
    const tarCommands = commands.filter(({ command }) => command === "tar")
    assert.ok(tarCommands.length > 0)
    assert.equal(tarCommands.every(({ args, cwd }) => args[0] === "-xzf" && args[1] === basename(args[1]) && !args[1].includes(":") && cwd === directory), true)
    assert.equal(commands.filter(({ args }) => args.some((arg) => /(?:minisearch|pi)-smoke\.mjs$/.test(arg))).length, 2)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a local native-and-Pi plan runs the Pi smoke", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-native-js-plan-"))
  try {
    const specs = packWorkspacePackages(directory, { mini: false, native: true })
    const plan = await createPublicationPlan({ directory, selection: selection(specs), registry: { policy: async () => ({ state: "unpublished", distTag: "latest" }) } })
    assert.deepEqual(
      await verifyLocalJsConsumers({ directory, plan, expectedCommit: releaseCommit }),
      specs
        .filter(({ name }) => name === "pi-okf-search")
        .map(({ name, version }) => ({ name, version })),
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a selected native version outside Pi's packed range can coexist with Pi's registry-compatible native", async () => {
  const directory = mkdtempSync(join(tmpdir(), "incompatible-js-plan-"))
  try {
    const specs = packWorkspacePackages(directory, { mini: false, native: true })
    const native = specs[0]
    const original = join(directory, `${native.name}-${native.version}.tgz`)
    const incompatible = join(directory, `${native.name}-0.4.0.tgz`)
    renameSync(original, incompatible)
    rewriteTarballManifest(incompatible, (manifest) => { manifest.version = "0.4.0" })
    native.version = "0.4.0"
    const plan = await createPublicationPlan({ directory, selection: selection(specs), registry: { policy: async () => ({ state: "unpublished", distTag: "latest" }) } })
    assert.deepEqual(
      await verifyLocalJsConsumers({ directory, plan, expectedCommit: releaseCommit }),
      specs
        .filter(({ name }) => name === "pi-okf-search")
        .map(({ name, version }) => ({ name, version })),
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("local JS consumer fails closed for wrong, missing, and mutated selected tarballs", async (t) => {
  for (const mode of ["wrong", "missing", "mutated"]) {
    await t.test(mode, async () => {
      const directory = mkdtempSync(join(tmpdir(), `invalid-js-plan-${mode}-`))
      try {
        const specs = packWorkspacePackages(directory)
        if (mode === "wrong") {
          const mini = specs[0]
          rmSync(join(directory, `${mini.name}-${mini.version}.tgz`))
          renameSync(join(directory, `${specs[1].name}-${specs[1].version}.tgz`), join(directory, `${mini.name}-${mini.version}.tgz`))
          await assert.rejects(
            createPublicationPlan({ directory, selection: selection([mini]), registry: { policy: async () => ({ state: "unpublished", distTag: "latest" }) } }),
            /package name/,
          )
          return
        }
        const plan = await createPublicationPlan({ directory, selection: selection(specs), registry: { policy: async () => ({ state: "unpublished", distTag: "latest" }) } })
        const tarball = join(directory, plan.packages[0].tarball)
        if (mode === "missing") rmSync(tarball)
        else writeFileSync(tarball, "mutated selected bytes")
        await assert.rejects(
          verifyLocalJsConsumers({ directory, plan, expectedCommit: releaseCommit }),
          mode === "missing" ? /ENOENT/ : /tar|artifact|exited/,
        )
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })
  }
})

test("native consumer uses the resolved Windows batch shape for install", async () => {
  const commands = []
  const dependency = join(tmpdir(), "release package.tgz")
  await withWindowsProcess(async () => {
    await verifyNativeConsumer(dependency, {
      runCommand: (command, args, options) => {
        commands.push({ command, args: [...args], options })
        return { status: 0, stdout: "", stderr: "" }
      },
    })
  })

  const install = commands.find(({ args }) => args[3] === "npm.cmd" && args[4] === "install")
  assert.ok(install)
  assert.equal(install.command, "C:\\Windows\\System32\\custom-cmd.exe")
  assert.deepEqual(install.args.slice(0, 5), ["/d", "/s", "/c", "npm.cmd", "install"])
  assert.equal(install.args.at(-1), dependency)
})

test("local native mode selects the planned tarball and runs all package consumers scripts-disabled", async () => {
  const spec = packageSpec("okf-search-native", "0.1.0")
  const data = await makePlan([spec], (directory) => packNative(directory))
  const commands = []
  const consumerSources = new Map()
  try {
    assert.deepEqual(
      await verifyLocalNativeConsumer({
        directory: data.directory,
        plan: data.plan,
        expectedCommit: releaseCommit,
        typescript: "/typescript/tsc",
        onCommand: ({ command, args, cwd, ...details }) => {
          commands.push({ command, args, cwd, ...details })
          if (command === process.execPath && /^(?:root|prepared)\.(?:mjs|cjs)$/.test(args[0])) {
            consumerSources.set(args[0], readFileSync(join(cwd, args[0]), "utf8"))
          }
        },
        runCommand: () => ({ status: 0, stdout: "", stderr: "" }),
      }),
      { name: "okf-search-native", version: "0.1.0" },
    )

    const install = commands.find(({ args }) => args[0] === "install")
    assert.ok(install)
    assert.equal(install.args.includes("--ignore-scripts"), true)
    assert.equal(install.args.at(-1), resolve(data.directory, data.plan.packages[0].tarball))
    assert.deepEqual([...consumerSources.keys()], ["root.mjs", "root.cjs", "prepared.mjs", "prepared.cjs"])
    assert.match(consumerSources.get("root.mjs"), /openOkf/)
    assert.match(consumerSources.get("root.mjs"), /index\.search\("release-added-needle", \{ match: "all" \}\)/)
    assert.match(consumerSources.get("prepared.mjs"), /ingestPrepared/)
    assert.equal(commands.some(({ args }) => args.includes("--project") && args.includes("tsconfig.json")), true)
  } finally {
    rmSync(data.directory, { recursive: true, force: true })
  }
})

async function transactionFixture(states = {}) {
  const specs = [packageSpec("okf-minisearch", "2.3.0"), packageSpec("pi-okf-search", "0.5.0")]
  return makePlan(specs, (directory) => {
    for (const spec of specs) packTarball(directory, spec.name, spec.version, { name: spec.name, version: spec.version, type: "module" })
  }, async (name) => ({ state: states[name] ?? "unpublished", distTag: states[name] === "published" ? "latest" : "latest" }))
}

function transactionAdapters(_data, initialStates) {
  const states = { ...initialStates }
  const events = []
  const registry = {
    policy: async (name) => { events.push(`policy:${name}`); return { state: states[name], distTag: "latest" } },
  }
  const publish = async (tarball, tag, entry) => {
    events.push(`publish:${entry.name}:${tarball}:${tag}`)
    states[entry.name] = "published"
  }
  return { states, events, registry, publish }
}

const transactionEnvironment = { GITHUB_SHA: releaseCommit, GITHUB_REF: "refs/heads/main" }

test("whole-plan preflight finishes before direct tarball publication", async () => {
  const data = await transactionFixture({ "okf-minisearch": "published", "pi-okf-search": "unpublished" })
  try {
    const adapters = transactionAdapters(data, { "okf-minisearch": "published", "pi-okf-search": "unpublished" })
    const result = await runPublicationTransaction({
      directory: data.directory,
      plan: data.plan,
      expectedSelection: data.selection,
      environment: transactionEnvironment,
      registry: adapters.registry,
      publish: adapters.publish,
      npmVersion: async () => "11.5.1",
    })
    const firstPublish = adapters.events.findIndex((event) => event.startsWith("publish:"))
    assert.deepEqual(adapters.events.slice(0, 2), [
      "policy:okf-minisearch",
      "policy:pi-okf-search",
    ])
    assert.match(adapters.events[firstPublish], new RegExp(`${data.plan.packages[1].tarball.replaceAll(".", "\\.")}:latest$`))
    assert.deepEqual(result, data.plan.packages.map(({ name, version }) => ({ name, version })))
    assert.equal(adapters.events.some((event) => /pack|build|verify|proof|ping|owner|oidc/.test(event)), false)
  } finally {
    rmSync(data.directory, { recursive: true, force: true })
  }
})

test("preflight and artifact failures stay before the first publish call", async (t) => {
  for (const [label, configure, pattern] of [
    ["last policy", (options) => {
      options.registry.policy = async (name) => {
        if (name === "pi-okf-search") throw new Error("last policy failed")
        return { state: "unpublished", distTag: "latest" }
      }
    }, /last policy failed/],
    ["changed artifact", (options, data) => { writeFileSync(join(data.directory, data.plan.packages[1].tarball), "changed") }, /artifact|tar/],
  ]) {
    await t.test(label, async () => {
      const data = await transactionFixture()
      try {
        const published = []
        const adapters = transactionAdapters(data, { "okf-minisearch": "unpublished", "pi-okf-search": "unpublished" })
        const options = {
          directory: data.directory,
          plan: data.plan,
          expectedSelection: data.selection,
          environment: transactionEnvironment,
          registry: adapters.registry,
          publish: async (_path, _tag, entry) => { published.push(entry.name) },
          npmVersion: async () => "11.5.1",
        }
        configure(options, data)
        await assert.rejects(runPublicationTransaction(options), pattern)
        assert.deepEqual(published, [])
      } finally {
        rmSync(data.directory, { recursive: true, force: true })
      }
    })
  }
})

test("publish failure stops dependency-order mutation", async () => {
  const data = await transactionFixture()
  try {
    const attempted = []
    const adapters = transactionAdapters(data, { "okf-minisearch": "unpublished", "pi-okf-search": "unpublished" })
    await assert.rejects(runPublicationTransaction({
      directory: data.directory,
      plan: data.plan,
      expectedSelection: data.selection,
      environment: transactionEnvironment,
      registry: adapters.registry,
      publish: async (_path, _tag, entry) => { attempted.push(entry.name); throw new Error("npm publish failed") },
      npmVersion: async () => "11.5.1",
    }), /npm publish failed/)
    assert.deepEqual(attempted, ["okf-minisearch"])
  } finally {
    rmSync(data.directory, { recursive: true, force: true })
  }
})

test("a version appearing after preflight is skipped", async () => {
  const data = await transactionFixture()
  try {
    const calls = new Map()
    const published = []
    const registry = {
      policy: async (name) => {
        const count = (calls.get(name) ?? 0) + 1
        calls.set(name, count)
        return { state: name === "okf-minisearch" && count > 1 ? "published" : "unpublished", distTag: "latest" }
      },
    }
    const result = await runPublicationTransaction({
      directory: data.directory,
      plan: data.plan,
      expectedSelection: data.selection,
      environment: transactionEnvironment,
      registry,
      publish: async (_path, _tag, entry) => { published.push(entry.name) },
      npmVersion: async () => "11.22.0",
    })
    assert.deepEqual(published, ["pi-okf-search"])
    assert.deepEqual(result, data.plan.packages.map(({ name, version }) => ({ name, version })))
  } finally {
    rmSync(data.directory, { recursive: true, force: true })
  }
})

test("an already-published historical entry is skipped with no tag and never mutated", async () => {
  const mini = packageSpec("okf-minisearch", "2.3.0")
  const data = await makePlan([mini], (directory) => {
    packTarball(directory, mini.name, mini.version, { name: mini.name, version: mini.version })
  }, async () => ({ state: "published", distTag: null }))
  try {
    let policyCalls = 0
    const result = await runPublicationTransaction({
      directory: data.directory,
      plan: data.plan,
      expectedSelection: data.selection,
      environment: transactionEnvironment,
      registry: {
        policy: async () => { policyCalls += 1; return { state: "published", distTag: null } },
      },
      publish: async () => assert.fail("historical entry was published"),
      npmVersion: async () => "11.5.1",
    })
    assert.deepEqual(result, [{ name: mini.name, version: mini.version }])
    assert.equal(policyCalls, 1)
  } finally {
    rmSync(data.directory, { recursive: true, force: true })
  }
})

test("transaction rejects an unpublished historical release before publication", async () => {
  const mini = packageSpec("okf-minisearch", "2.3.0")
  const data = await makePlan([mini], (directory) => {
    packTarball(directory, mini.name, mini.version, { name: mini.name, version: mini.version })
  })
  try {
    const published = []
    const registry = {
      policy: async (name, version) => packagePublicationPolicy(name, version, async (url) => {
        assert.equal(url, `${NPM_REGISTRY}/${name}`)
        return {
          status: 200,
          json: async () => ({ name, "dist-tags": { latest: "2.4.0" }, versions: {} }),
        }
      }),
    }
    await assert.rejects(runPublicationTransaction({
      directory: data.directory,
      plan: data.plan,
      expectedSelection: data.selection,
      environment: transactionEnvironment,
      registry,
      publish: async (_path, _tag, entry) => { published.push(entry.name) },
      npmVersion: async () => "11.5.1",
    }), /latest is newer/)
    assert.deepEqual(published, [])
  } finally {
    rmSync(data.directory, { recursive: true, force: true })
  }
})

test("a newer latest appearing after preflight stops before the later mutation", async () => {
  const data = await transactionFixture()
  try {
    const policyCalls = new Map()
    const published = []
    const registry = {
      policy: async (name) => {
        const count = (policyCalls.get(name) ?? 0) + 1
        policyCalls.set(name, count)
        if (name === "pi-okf-search" && count === 2) throw new Error("latest is newer (0.6.0)")
        return { state: "unpublished", distTag: "latest" }
      },
    }
    await assert.rejects(runPublicationTransaction({
      directory: data.directory,
      plan: data.plan,
      expectedSelection: data.selection,
      environment: transactionEnvironment,
      registry,
      publish: async (_path, _tag, entry) => { published.push(entry.name) },
      npmVersion: async () => "11.5.1",
    }), /latest is newer/)
    assert.deepEqual(published, ["okf-minisearch"])
  } finally {
    rmSync(data.directory, { recursive: true, force: true })
  }
})

test("transaction skips exact versions and publishes missing entries in dependency order", async () => {
  const specs = [
    packageSpec("okf-minisearch", "2.3.0"),
    packageSpec("okf-search-native", "0.1.0"),
    packageSpec("pi-okf-search", "0.5.0"),
  ]
  const data = await makePlan(specs, (directory) => {
    packTarball(directory, specs[0].name, specs[0].version, { name: specs[0].name, version: specs[0].version })
    packNative(directory)
    packTarball(directory, specs[2].name, specs[2].version, { name: specs[2].name, version: specs[2].version })
  }, async (name) => ({ state: name === "okf-minisearch" ? "published" : "unpublished", distTag: "latest" }))
  try {
    const states = { "okf-minisearch": "published", "pi-okf-search": "unpublished", "okf-search-native": "unpublished" }
    const published = []
    const registry = {
      policy: async (name) => ({ state: states[name], distTag: "latest" }),
    }
    const result = await runPublicationTransaction({
      directory: data.directory,
      plan: data.plan,
      expectedSelection: data.selection,
      environment: transactionEnvironment,
      registry,
      publish: async (tarball, tag, entry) => {
        published.push({ name: entry.name, tarball, tag })
        states[entry.name] = "published"
      },
      npmVersion: async () => "11.5.1",
    })
    assert.deepEqual(published, [
      { name: "okf-search-native", tarball: join(data.directory, data.plan.packages[1].tarball), tag: "latest" },
      { name: "pi-okf-search", tarball: join(data.directory, data.plan.packages[2].tarball), tag: "latest" },
    ])
    assert.deepEqual(result, specs.map(({ name, version }) => ({ name, version })))
  } finally {
    rmSync(data.directory, { recursive: true, force: true })
  }
})

test("rerunning after a partial publish skips the existing exact version", async () => {
  const data = await transactionFixture()
  try {
    const adapters = transactionAdapters(data, { "okf-minisearch": "unpublished", "pi-okf-search": "unpublished" })
    const firstAttempt = []
    await assert.rejects(runPublicationTransaction({
      directory: data.directory,
      plan: data.plan,
      expectedSelection: data.selection,
      environment: transactionEnvironment,
      registry: adapters.registry,
      publish: async (_path, _tag, entry) => {
        firstAttempt.push(entry.name)
        if (entry.name === "pi-okf-search") throw new Error("second publication interrupted")
        adapters.states[entry.name] = "published"
      },
      npmVersion: async () => "11.5.1",
    }), /second publication interrupted/)
    assert.deepEqual(firstAttempt, ["okf-minisearch", "pi-okf-search"])
    assert.equal(adapters.states["okf-minisearch"], "published")
    assert.equal(adapters.states["pi-okf-search"], "unpublished")

    const retryStart = adapters.events.length
    const retryPublished = []
    const result = await runPublicationTransaction({
      directory: data.directory,
      plan: data.plan,
      expectedSelection: data.selection,
      environment: transactionEnvironment,
      registry: adapters.registry,
      publish: async (tarball, tag, entry) => {
        retryPublished.push({ name: entry.name, tarball, tag })
        await adapters.publish(tarball, tag, entry)
      },
      npmVersion: async () => "11.5.1",
    })
    assert.deepEqual(retryPublished, [{
      name: "pi-okf-search",
      tarball: join(data.directory, data.plan.packages[1].tarball),
      tag: "latest",
    }])
    assert.deepEqual(result, data.plan.packages.map(({ name, version }) => ({ name, version })))
    const retryEvents = adapters.events.slice(retryStart)
    assert.equal(retryEvents.filter((event) => event === "publish:okf-minisearch").length, 0)
  } finally {
    rmSync(data.directory, { recursive: true, force: true })
  }
})

test("release workflow keeps the transaction DAG, target CPU bindings, and candidate failure policy", () => {
  const path = new URL("../.github/workflows/release-please.yml", import.meta.url)
  const parsed = JSON.parse(execFileSync("ruby", ["-r", "yaml", "-r", "json", "-e", "print JSON.generate(YAML.safe_load(File.read(ARGV[0]), aliases: true))", path.pathname], { encoding: "utf8" }))
  assert.deepEqual(Object.keys(parsed.jobs), [
    "release_please", "release_metadata", "native_release_build", "candidate_plan",
    "native_candidate_test", "publication_transaction",
  ])
  const needs = (name) => [parsed.jobs[name].needs].flat().filter(Boolean)
  assert.deepEqual(needs("candidate_plan"), ["release_metadata", "native_release_build"])
  assert.deepEqual(needs("publication_transaction"), ["release_metadata", "candidate_plan", "native_candidate_test"])
  assert.equal(Object.values(parsed.jobs).filter((job) => job.environment === "npm-production").length, 1)
  assert.equal(
    parsed.jobs.release_metadata.outputs.pi_released,
    "${{ steps.candidates.outputs.pi_released }}",
  )
  const candidateSteps = parsed.jobs.candidate_plan.steps
  const setupPiRust = candidateSteps.find(({ name }) => name === "Setup Rust for the Pi native backend")
  const buildPiNative = candidateSteps.find(({ name }) => name === "Build the Pi native backend")
  assert.match(setupPiRust.if, /pi_released == 'true'.*native_released == 'false'/)
  assert.equal(setupPiRust.with.toolchain, "1.88.0")
  assert.equal(buildPiNative.if, setupPiRust.if)
  assert.equal(buildPiNative.run, "pnpm --dir packages/okf-search-native run build")
  assert.ok(
    candidateSteps.findIndex(({ name }) => name === "Assemble and verify exact native files") <
      candidateSteps.findIndex(({ name }) => name === "Build and test selected JavaScript packages"),
  )

  const candidateJob = parsed.jobs.native_candidate_test
  assert.equal(candidateJob.strategy["fail-fast"], false)
  assert.equal(candidateJob["continue-on-error"], "${{ matrix.allow-failure }}")
  assert.deepEqual(
    Object.fromEntries(candidateJob.strategy.matrix.include.map(({ target, "allow-failure": allowFailure }) => [target, allowFailure])),
    {
      "x86_64-unknown-linux-gnu": false,
      "x86_64-apple-darwin": false,
      "aarch64-apple-darwin": false,
      "x86_64-pc-windows-msvc": true,
    },
  )
  assert.match(parsed.jobs.publication_transaction.if, /always\(\)/)
  assert.match(parsed.jobs.publication_transaction.if, /needs\.native_candidate_test\.result == 'success'/)
  assert.equal(parsed.jobs.publication_transaction.name, "Publish packages to npm")
  const releaseSteps = parsed.jobs.native_release_build.steps
  assert.equal(releaseSteps.find(({ name }) => name === "Install dependencies for target CPU").run, "pnpm install --frozen-lockfile --cpu=${{ matrix.node-arch }}")
  assert.equal(parsed.jobs.native_release_build.strategy.matrix.include.length, 4)
  assert.equal(parsed.jobs.native_candidate_test.strategy.matrix.include.length, 4)
  assert.equal(
    parsed.jobs.native_candidate_test.steps.find(({ name }) =>
      name === "Install proof dependencies without scripts for target CPU"
    ).run,
    "pnpm install --frozen-lockfile --ignore-scripts --cpu=${{ matrix.node-arch }}",
  )
  const transactionCommands = parsed.jobs.publication_transaction.steps.map(({ run }) => run ?? "").join("\n")
  assert.doesNotMatch(transactionCommands, /npm pack|napi build|build:facade/)
  assert.match(transactionCommands, /release-publication\.mjs transact/)

  const workflowSource = readFileSync(path, "utf8")
  assert.doesNotMatch(workflowSource, /release-publication\.mjs verify/)
  assert.doesNotMatch(workflowSource, /verify-(?:js|native)-consumer\.mjs/)
  assert.match(workflowSource, /verify-release-consumer\.mjs local-js/)
  assert.match(workflowSource, /verify-release-consumer\.mjs local-native/)
  assert.doesNotMatch(workflowSource, /verify-release-consumer\.mjs registry/)
  assert.doesNotMatch(workflowSource, /(?:js|native)_post_publish_test/)
  assert.match(workflowSource, /Validate the plan and publish missing tarballs only/)
  const nativeConsumerCommands = ["native_candidate_test"]
    .flatMap((job) => parsed.jobs[job].steps.map(({ run }) => run ?? ""))
    .join("\n")
  assert.doesNotMatch(nativeConsumerCommands, /jq .*okf-search-native/)
})
