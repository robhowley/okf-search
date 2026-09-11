import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const library = {
  darwin: "libokf_prepare_native.dylib",
  linux: "libokf_prepare_native.so",
  win32: "okf_prepare_native.dll",
}[process.platform];
if (!library) throw new Error(`Unsupported build host: ${process.platform}`);

const rustc = spawnSync("rustc", ["-vV"], { cwd: root, encoding: "utf8" });
if (rustc.error) throw rustc.error;
if (rustc.status !== 0) throw new Error(`rustc failed: ${rustc.stderr}`);
const host = /^host: (.+)$/m.exec(rustc.stdout)?.[1];
if (!host) throw new Error("rustc did not report its host target");

// Explicitly build for this host, even if Cargo has a default cross target.
const target = resolve(root, "target");
const binary = resolve(root, "okf-prepare-native.node");
rmSync(binary, { force: true });
rmSync(resolve(root, "dist"), { recursive: true, force: true });
const result = spawnSync("cargo", ["build", "--locked", "--target", host, "--target-dir", target], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Cargo build exited with ${result.status}`);
copyFileSync(resolve(target, host, "debug", library), binary);
mkdirSync(resolve(root, "dist"), { recursive: true });
await build({
  entryPoints: [resolve(root, "src/index.ts")],
  outfile: resolve(root, "dist/index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["../native.cjs"],
});
