#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

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

const options = parseOptions(process.argv.slice(2));
if (typeof global.gc !== "function") {
  throw new Error("Run memory retention with node --expose-gc");
}
const root = resolve(options.root);
const corpus = await fingerprintCorpus(root);
assertPrivateCorpus(corpus);
global.gc();
global.gc();
const initial = snapshot();
const cycles = [];

for (let cycle = 1; cycle <= options.cycles; cycle += 1) {
  let inputs = await readOkfDocuments(root);
  const afterRead = snapshot();
  let prepared = prepareOkfDocuments(inputs);
  const inventory = {
    documents: prepared.length,
    sections: prepared.reduce((sum, document) => sum + document.sections.length, 0),
    degradedDocuments: prepared.filter(({ conformance }) => conformance === "degraded").length,
  };
  if (
    inventory.documents !== PRIVATE_CORPUS.documents
    || inventory.sections !== PRIVATE_CORPUS.sections
    || inventory.degradedDocuments !== PRIVATE_CORPUS.degradedDocuments
  ) {
    throw new Error(`Prepared inventory mismatch: ${JSON.stringify(inventory)}`);
  }
  const afterPrepare = snapshot();
  inputs = undefined;
  prepared = undefined;
  global.gc();
  global.gc();
  const afterDrop = snapshot();
  cycles.push({ cycle, inventory, afterRead, afterPrepare, afterDrop });
}

const final = cycles.at(-1).afterDrop;
const evidence = {
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  command: [
    "pnpm --filter @okf-internal/prepare benchmark:memory",
    `--root ${JSON.stringify(root)}`,
    `--cycles ${options.cycles}`,
    ...(options.output ? [`--output ${JSON.stringify(options.output)}`] : []),
  ].join(" "),
  protocol: {
    measuredCycles: options.cycles,
    processReuse: "all read/prepare/drop cycles run in one process",
    filesystemWarmup: "full manifest fingerprint read before the initial snapshot",
    garbageCollection: "--expose-gc twice before the initial snapshot and after every drop",
    build: "TypeScript compiled JavaScript",
  },
  corpus,
  host: hostEvidence(),
  repository: repositoryEvidence(),
  artifactFingerprint: await artifactFingerprint(),
  cycles,
  initial,
  final,
  retainedGrowthBytes: difference(final, initial),
  maxRssBytes: process.resourceUsage().maxRSS * 1024,
};
if (options.output) {
  await writeFile(resolve(options.output), `${JSON.stringify(evidence, null, 2)}\n`);
}
console.log(JSON.stringify(evidence));

function snapshot() {
  const value = process.memoryUsage();
  return {
    rss: value.rss,
    heapTotal: value.heapTotal,
    heapUsed: value.heapUsed,
    external: value.external,
    arrayBuffers: value.arrayBuffers,
  };
}

function difference(left, right) {
  return Object.fromEntries(
    Object.keys(left).map((key) => [key, left[key] - right[key]]),
  );
}

function parseOptions(args) {
  let root = process.env.OKF_CORPUS ?? `${process.env.HOME}/Documents/wiki-w-type`;
  let cycles = 3;
  let output;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--root" && args[index + 1]) {
      root = args[++index];
    } else if (args[index] === "--cycles" && args[index + 1]) {
      cycles = Number(args[++index]);
    } else if (args[index] === "--output" && args[index + 1]) {
      output = args[++index];
    } else {
      throw new Error(`Unknown argument: ${args[index]}`);
    }
  }
  if (!Number.isSafeInteger(cycles) || cycles < 2) {
    throw new Error("--cycles must be an integer of at least 2");
  }
  return { root, cycles, output };
}
