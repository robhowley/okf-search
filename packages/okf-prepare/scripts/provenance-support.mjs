import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { cpus, freemem, hostname, platform, release, totalmem } from "node:os";
import { relative, resolve, sep } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(packageRoot, "../..");

export function hostEvidence() {
  const processors = cpus();
  return {
    hostname: hostname(),
    platform: platform(),
    release: release(),
    architecture: process.arch,
    node: process.version,
    cpuModel: processors[0]?.model ?? "unknown",
    logicalCpuCount: processors.length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytesAtReport: freemem(),
  };
}

export function repositoryEvidence() {
  const status = run("git", [
    "-C",
    repositoryRoot,
    "status",
    "--short",
    "--untracked-files=all",
  ]);
  return {
    commit: run("git", ["-C", repositoryRoot, "rev-parse", "HEAD"]),
    dirty: status.length > 0,
    changes: status ? status.split("\n") : [],
  };
}

export async function artifactFingerprint() {
  const distRoot = resolve(packageRoot, "dist");
  const runtimePaths = (await readdir(distRoot))
    .filter((path) => path.endsWith(".js"))
    .sort()
    .map((path) => resolve(distRoot, path));
  const manifestPath = resolve(packageRoot, "package.json");
  const lockPath = resolve(repositoryRoot, "pnpm-lock.yaml");
  const hash = createHash("sha256");
  const files = [];

  for (const absolutePath of [...runtimePaths, manifestPath, lockPath]) {
    const path = relative(repositoryRoot, absolutePath).split(sep).join("/");
    const pathBytes = Buffer.from(path, "utf8");
    const bytes = await readFile(absolutePath);
    hash.update(lengthPrefix(pathBytes.byteLength));
    hash.update(pathBytes);
    hash.update(lengthPrefix(bytes.byteLength));
    hash.update(bytes);
    files.push({
      path,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }

  const packageManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  return {
    sha256: hash.digest("hex"),
    runtimeFiles: files.slice(0, runtimePaths.length),
    dependencyManifest: {
      ...files[runtimePaths.length],
      dependencies: packageManifest.dependencies,
    },
    dependencyLock: files.at(-1),
  };
}

function lengthPrefix(length) {
  const prefix = Buffer.allocUnsafe(8);
  prefix.writeBigUInt64BE(BigInt(length));
  return prefix;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trimEnd();
}
