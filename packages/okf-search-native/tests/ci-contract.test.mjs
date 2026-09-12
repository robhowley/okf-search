import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildNativePackage,
  parseBuildArguments,
} from "../scripts/build.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflows = {
  source: {
    path: join(packageRoot, "..", "..", ".github", "workflows", "ci.yml"),
    job: "native-artifacts",
  },
  release: {
    path: join(packageRoot, "..", "..", ".github", "workflows", "release-please.yml"),
    job: "native_release_build",
  },
};

const expectedRows = [
  {
    runner: "ubuntu-latest",
    target: "x86_64-unknown-linux-gnu",
    "node-arch": "x64",
    artifact: "okf-search-native.linux-x64-gnu.node",
    "napi-cross": true,
    "macos-deployment-target": "",
  },
  {
    runner: "macos-latest",
    target: "x86_64-apple-darwin",
    "node-arch": "x64",
    artifact: "okf-search-native.darwin-x64.node",
    "napi-cross": false,
    "macos-deployment-target": "10.13",
  },
  {
    runner: "macos-latest",
    target: "aarch64-apple-darwin",
    "node-arch": "arm64",
    artifact: "okf-search-native.darwin-arm64.node",
    "napi-cross": false,
    "macos-deployment-target": "10.13",
  },
  {
    runner: "windows-latest",
    target: "x86_64-pc-windows-msvc",
    "node-arch": "x64",
    artifact: "okf-search-native.win32-x64-msvc.node",
    "napi-cross": false,
    "macos-deployment-target": "",
  },
];

async function parseWorkflow(path) {
  const ruby = "print JSON.generate(YAML.safe_load(File.read(ARGV[0]), aliases: true))";
  const { stdout } = await execFileAsync("ruby", ["-r", "yaml", "-r", "json", "-e", ruby, path]);
  return JSON.parse(stdout);
}

for (const [label, spec] of Object.entries(workflows)) {
  test(`${label} native matrix binds Node and dependency installation to all four target CPUs`, async () => {
    const workflow = await parseWorkflow(spec.path);
    const job = workflow.jobs[spec.job];
    assert.deepEqual(job.strategy.matrix.include, expectedRows);
    const setup = job.steps.find(({ name }) => name === "Setup Node.js");
    assert.equal(setup.with.architecture, "${{ matrix.node-arch }}");
    const install = job.steps.find(({ run }) => run?.startsWith("pnpm install --frozen-lockfile"));
    assert.equal(install.run, "pnpm install --frozen-lockfile --cpu=${{ matrix.node-arch }}");
  });
}

test("the build owner applies common flags, target options, and facade sequencing", async () => {
  const events = [];
  await buildNativePackage(
    parseBuildArguments([
      "--release",
      "--target",
      "x86_64-unknown-linux-gnu",
      "--use-napi-cross=true",
    ]),
    {
      runCommand: (command, args, options) => {
        events.push({ command, args, options });
        return { status: 0 };
      },
      buildFacade: async () => { events.push("facade"); },
    },
  );

  assert.equal(events[0].command, process.execPath);
  assert.match(events[0].args[0], /@napi-rs[/\\]cli[/\\]dist[/\\]cli\.js$/);
  assert.deepEqual(events[0].args.slice(1), [
    "build",
    "--platform",
    "--release",
    "--js",
    "native.cjs",
    "--dts",
    "native.d.cts",
    "--target",
    "x86_64-unknown-linux-gnu",
    "--use-napi-cross",
    "--",
    "--locked",
  ]);
  assert.equal(events[0].options.stdio, "inherit");
  assert.equal(events[1], "facade");
  assert.deepEqual(
    parseBuildArguments(["--target", "x86_64-pc-windows-msvc", "--use-napi-cross=false"]),
    { release: false, target: "x86_64-pc-windows-msvc", useNapiCross: false },
  );
});

test("native package exposes one complete build boundary and portable facade test selection", async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.scripts), [
    "build",
    "build:debug",
    "build:facade",
    "check:rust",
    "test:types",
    "test:package-api",
    "test:rust",
    "test:prepare-bundle",
    "typecheck",
    "test",
    "verify:release-artifacts",
  ]);
  assert.equal(manifest.scripts.build, "node scripts/build.mjs --release");
  assert.equal(manifest.scripts["build:debug"], "node scripts/build.mjs");
  assert.doesNotMatch(manifest.scripts.test, /\*/);
  assert.match(manifest.scripts.test, /--no-file-parallelism/);
  for (const filename of [
    "directory.test.ts",
    "lifecycle.test.ts",
    "raw-boundary.test.ts",
    "root-contract.test.ts",
    "search-options.test.ts",
  ]) {
    assert.match(manifest.scripts.test, new RegExp(`tests/${filename.replaceAll(".", "\\.")}`));
  }
});

test("native workflows preserve build, package API, GLIBC, and upload gates", async () => {
  for (const { path, job } of Object.values(workflows)) {
    const parsed = await parseWorkflow(path);
    const steps = parsed.jobs[job].steps;
    const commands = steps.map(({ run }) => run ?? "").join("\n");
    const build = steps.find(({ name }) => name === "Build native package");
    assert.equal(
      build.run,
      'pnpm --dir packages/okf-search-native run build --target "${{ matrix.target }}" --use-napi-cross=${{ matrix.napi-cross }}',
    );
    assert.equal(build.shell, undefined);
    assert.doesNotMatch(commands, /napi build|run build:facade/);

    const glibc = steps.find(({ name }) => name === "Verify Linux glibc floor");
    assert.equal(glibc.if, "matrix.target == 'x86_64-unknown-linux-gnu'");
    assert.equal(
      glibc.run,
      'pnpm --dir packages/okf-search-native run verify:release-artifacts glibc "${{ matrix.artifact }}"',
    );
    const runtime = steps.findIndex(({ run }) =>
      run === "pnpm --dir packages/okf-search-native run test:package-api"
    );
    assert.ok(runtime >= 0);
    assert.ok(runtime < steps.findIndex(({ name }) => name === "Upload tested artifact"));
  }
});
