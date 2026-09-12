#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { readOkfDocuments } from "../dist/node.js";
import { prepareOkfDocuments } from "../dist/index.js";
import {
  assertPrivateCorpus,
  fingerprintCorpus,
  PRIVATE_CORPUS,
} from "./corpus-support.mjs";
import { encodeStructural } from "./typed-structural-encoder.mjs";

const options = parseOptions(process.argv.slice(2));
const root = resolve(options.root);
const manifest = await fingerprintCorpus(root);
assertPrivateCorpus(manifest);

const inputs = await readOkfDocuments(root);
const prepared = prepareOkfDocuments(inputs);
const sections = prepared.reduce(
  (total, document) => total + document.sections.length,
  0,
);
const degradedDocuments = prepared.filter(
  ({ conformance }) => conformance === "degraded",
).length;
if (
  prepared.length !== PRIVATE_CORPUS.documents
  || sections !== PRIVATE_CORPUS.sections
  || degradedDocuments !== PRIVATE_CORPUS.degradedDocuments
) {
  throw new Error(
    `Prepared corpus inventory mismatch: ${JSON.stringify({
      documents: prepared.length,
      sections,
      degradedDocuments,
    })}`,
  );
}

const outputHash = createHash("sha256");
for (const document of prepared) {
  const encoded = encodeStructural(document);
  outputHash.update(lengthPrefix(encoded.byteLength));
  outputHash.update(encoded);
}

const evidence = {
  schemaVersion: 1,
  corpus: manifest,
  prepared: {
    documents: prepared.length,
    sections,
    degradedDocuments,
    outputFingerprint: outputHash.digest("hex"),
    framing: "ordered prepared documents; each typed encoding prefixed by unsigned 64-bit big-endian byte length",
  },
};

if (options.output) {
  await writeFile(resolve(options.output), `${JSON.stringify(evidence, null, 2)}\n`);
} else {
  const expectedPath = new URL("../test/evidence/corpus-oracle.json", import.meta.url);
  const expected = JSON.parse(await readFile(expectedPath, "utf8"));
  if (JSON.stringify(expected) !== JSON.stringify(evidence)) {
    throw new Error(
      `Corpus oracle differs from ${expectedPath.pathname}: expected ${expected.prepared?.outputFingerprint}, got ${evidence.prepared.outputFingerprint}`,
    );
  }
}
console.log(JSON.stringify(evidence));

function lengthPrefix(length) {
  const prefix = Buffer.allocUnsafe(8);
  prefix.writeBigUInt64BE(BigInt(length));
  return prefix;
}

function parseOptions(args) {
  let root = process.env.OKF_CORPUS ?? `${process.env.HOME}/Documents/wiki-w-type`;
  let output;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--root" && args[index + 1]) {
      root = args[++index];
    } else if (args[index] === "--output" && args[index + 1]) {
      output = args[++index];
    } else {
      throw new Error(`Unknown argument: ${args[index]}`);
    }
  }
  return { root, output };
}
