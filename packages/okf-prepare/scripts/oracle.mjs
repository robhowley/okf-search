#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import * as nodeApi from "../dist/node.js";
import * as rootApi from "../dist/index.js";
import { captureOracle } from "./oracle-fixtures.mjs";
import {
  byteDifference,
  encodeStructural,
} from "./typed-structural-encoder.mjs";

const typedFixturePath = resolve(
  import.meta.dirname,
  "../test/fixtures/oracle-v1.typed",
);
const evidencePath = resolve(
  import.meta.dirname,
  "../test/fixtures/oracle-v1.json",
);

const options = parseOptions(process.argv.slice(2));
const encodedRuns = [];
let oracle;
for (let run = 0; run < options.repeat; run += 1) {
  const captured = await captureOracle(rootApi, nodeApi, run);
  oracle ??= captured;
  encodedRuns.push(encodeStructural(captured));
}

const first = encodedRuns[0];
for (let run = 1; run < encodedRuns.length; run += 1) {
  assertBytes(first, encodedRuns[run], `run 1 and run ${run + 1}`);
}

const fingerprint = createHash("sha256").update(first).digest("hex");
const evidence = {
  schemaVersion: oracle.schemaVersion,
  fingerprint,
  bytes: first.byteLength,
  repeatCount: options.repeat,
  byteIdentical: true,
  dependencies: oracle.dependencies,
  exports: oracle.exports,
  fixtureInventory: oracle.fixtureInventory,
  shapeInventory: oracle.shapeInventory,
  demo: {
    ...oracle.demo.manifestFingerprint,
    sections: oracle.demo.sections,
    degradedDocuments: oracle.demo.degradedDocuments,
  },
};

if (options.update) {
  await mkdir(new URL("../test/fixtures/", import.meta.url), { recursive: true });
  await writeFile(typedFixturePath, first);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`updated ${typedFixturePath}`);
  console.log(`updated ${evidencePath}`);
} else {
  const expected = await readFile(typedFixturePath);
  assertBytes(expected, first, "checked-in fixture and current oracle");
  const recorded = JSON.parse(await readFile(evidencePath, "utf8"));
  if (JSON.stringify(recorded) !== JSON.stringify(evidence)) {
    throw new Error("Oracle JSON evidence does not match the current oracle");
  }
}

console.log(JSON.stringify({
  fingerprint,
  bytes: first.byteLength,
  repeatCount: options.repeat,
  byteIdentical: true,
  demo: evidence.demo,
}));

function assertBytes(expected, actual, label) {
  const difference = byteDifference(expected, actual);
  if (difference) {
    throw new Error(
      `Structural oracle mismatch (${label}): ${JSON.stringify(difference)}`,
    );
  }
}

function parseOptions(args) {
  let repeat = 10;
  let update = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--update") {
      update = true;
    } else if (args[index] === "--repeat" && args[index + 1]) {
      repeat = Number(args[index + 1]);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${args[index]}`);
    }
  }
  if (!Number.isSafeInteger(repeat) || repeat < 1) {
    throw new Error("--repeat must be a positive integer");
  }
  return { repeat, update };
}
