#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readOkfDocuments } from "../dist/node.js";
import { prepareOkfDocuments } from "../dist/index.js";
import {
  assertPrivateCorpus,
  fingerprintCorpus,
  PRIVATE_CORPUS,
} from "./corpus-support.mjs";
import {
  artifactFingerprint,
  hostEvidence,
  repositoryEvidence,
} from "./provenance-support.mjs";

if (process.argv.includes("--worker")) {
  await worker(resolve(argument("--root")));
} else {
  await parent(parseOptions(process.argv.slice(2)));
}

async function parent(options) {
  const root = resolve(options.root);
  const manifest = await fingerprintCorpus(root);
  assertPrivateCorpus(manifest);

  const samples = [];
  let warmup;
  for (let index = 0; index <= options.samples; index += 1) {
    // Read all bytes outside the measured child so each sample starts warm.
    assertPrivateCorpus(await fingerprintCorpus(root));
    const result = spawnSync(process.execPath, [
      "--expose-gc",
      fileURL(),
      "--worker",
      "--root",
      root,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(result.stderr || `Baseline child exited ${result.status}`);
    }
    const sample = JSON.parse(result.stdout.trim());
    if (index === 0) warmup = sample;
    else samples.push(sample);
  }

  const evidence = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    command: [
      "pnpm --filter @okf-internal/prepare benchmark",
      `--root ${JSON.stringify(root)}`,
      `--samples ${options.samples}`,
      ...(options.output ? [`--output ${JSON.stringify(options.output)}`] : []),
    ].join(" "),
    protocol: {
      warmupFreshProcesses: 1,
      measuredFreshProcesses: options.samples,
      filesystemWarmup: "full manifest fingerprint read before every child",
      garbageCollection: "--expose-gc before baseline and after dropping inputs/results",
      build: "TypeScript compiled JavaScript",
    },
    corpus: manifest,
    host: hostEvidence(),
    repository: repositoryEvidence(),
    artifactFingerprint: await artifactFingerprint(),
    warmup,
    summary: summarize(samples, manifest),
    samples,
  };

  if (options.output) {
    await writeFile(resolve(options.output), `${JSON.stringify(evidence, null, 2)}\n`);
  }
  console.log(JSON.stringify(evidence));
}

async function worker(root) {
  if (typeof global.gc !== "function") {
    throw new Error("Baseline worker requires --expose-gc");
  }
  global.gc();
  const before = process.memoryUsage();
  const started = process.hrtime.bigint();
  const cpuStarted = process.cpuUsage();

  const readStarted = process.hrtime.bigint();
  const readCpuStarted = process.cpuUsage();
  let inputs = await readOkfDocuments(root);
  const read = timing(readStarted, readCpuStarted);
  const afterRead = process.memoryUsage();

  const prepareStarted = process.hrtime.bigint();
  const prepareCpuStarted = process.cpuUsage();
  let prepared = prepareOkfDocuments(inputs);
  const prepare = timing(prepareStarted, prepareCpuStarted);
  const total = timing(started, cpuStarted);
  const afterPrepare = process.memoryUsage();
  const inventory = {
    documents: prepared.length,
    sections: prepared.reduce(
      (count, document) => count + document.sections.length,
      0,
    ),
    degradedDocuments: prepared.filter(
      ({ conformance }) => conformance === "degraded",
    ).length,
  };
  if (
    inventory.documents !== PRIVATE_CORPUS.documents
    || inventory.sections !== PRIVATE_CORPUS.sections
    || inventory.degradedDocuments !== PRIVATE_CORPUS.degradedDocuments
  ) {
    throw new Error(`Prepared inventory mismatch: ${JSON.stringify(inventory)}`);
  }

  inputs = undefined;
  prepared = undefined;
  global.gc();
  global.gc();
  const afterDrop = process.memoryUsage();
  const maxRssBytes = process.resourceUsage().maxRSS * 1024;

  console.log(JSON.stringify({
    read,
    prepare,
    total,
    inventory,
    memory: {
      before: memory(before),
      afterRead: memory(afterRead),
      afterPrepare: memory(afterPrepare),
      afterDrop: memory(afterDrop),
      retainedGrowth: subtractMemory(afterDrop, before),
      maxRssBytes,
    },
  }));
}

function summarize(samples, corpus) {
  const phase = (name) => {
    const wall = samples.map((sample) => sample[name].wallMs);
    const cpu = samples.map((sample) => sample[name].cpuMs);
    return {
      wallMs: distribution(wall),
      cpuMs: distribution(cpu),
      documentsPerSecondAtP50: round(corpus.documents / (percentile(wall, 0.5) / 1000)),
      mibPerSecondAtP50: round(
        corpus.bytes / 1024 / 1024 / (percentile(wall, 0.5) / 1000),
      ),
    };
  };

  const fields = ["rss", "heapTotal", "heapUsed", "external", "arrayBuffers"];
  const memorySummary = {};
  for (const point of ["before", "afterRead", "afterPrepare", "afterDrop", "retainedGrowth"]) {
    memorySummary[point] = {};
    for (const field of fields) {
      memorySummary[point][field] = distribution(
        samples.map((sample) => sample.memory[point][field]),
      );
    }
  }
  memorySummary.maxRssBytes = distribution(
    samples.map((sample) => sample.memory.maxRssBytes),
  );

  return {
    read: phase("read"),
    prepare: phase("prepare"),
    total: phase("total"),
    memoryBytes: memorySummary,
  };
}

function distribution(values) {
  return {
    min: Math.min(...values),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
  };
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * quantile) - 1];
}

function timing(started, cpuStarted) {
  const cpu = process.cpuUsage(cpuStarted);
  return {
    wallMs: round(Number(process.hrtime.bigint() - started) / 1e6),
    cpuMs: round((cpu.user + cpu.system) / 1000),
  };
}

function memory(usage) {
  return {
    rss: usage.rss,
    heapTotal: usage.heapTotal,
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  };
}

function subtractMemory(left, right) {
  return Object.fromEntries(
    Object.keys(memory(left)).map((key) => [key, left[key] - right[key]]),
  );
}

function fileURL() {
  return fileURLToPath(import.meta.url);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) {
    throw new Error(`${name} requires a value`);
  }
  return process.argv[index + 1];
}

function parseOptions(args) {
  let root = process.env.OKF_CORPUS ?? `${process.env.HOME}/Documents/wiki-w-type`;
  let samples = 20;
  let output;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--root" && args[index + 1]) {
      root = args[++index];
    } else if (args[index] === "--samples" && args[index + 1]) {
      samples = Number(args[++index]);
    } else if (args[index] === "--output" && args[index + 1]) {
      output = args[++index];
    } else {
      throw new Error(`Unknown argument: ${args[index]}`);
    }
  }
  if (!Number.isSafeInteger(samples) || samples < 1) {
    throw new Error("--samples must be a positive integer");
  }
  return { root, samples, output };
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
