import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export const PRIVATE_CORPUS = Object.freeze({
  documents: 13_692,
  bytes: 62_463_920,
  manifestFingerprint: "f57b9a3f8a54073b61f258b5bd29d65fd32576ee2a97e8618a1e7871b1ddab6e",
  sections: 109_990,
  degradedDocuments: 1_248,
});

export async function fingerprintCorpus(root) {
  const { files: _, ...fingerprint } = await fingerprintCorpusFiles(root);
  return fingerprint;
}

export async function fingerprintCorpusFiles(root) {
  const candidates = await findCandidates(root, root);
  candidates.sort((left, right) => compare(left.path, right.path));

  const hash = createHash("sha256");
  const files = [];
  let bytes = 0;
  for (const candidate of candidates) {
    const pathBytes = Buffer.from(candidate.path, "utf8");
    const contents = await readFile(candidate.absolutePath);
    files.push({ path: candidate.path, bytes: contents.byteLength });
    bytes += contents.byteLength;
    hash.update(lengthPrefix(pathBytes.byteLength));
    hash.update(pathBytes);
    hash.update(lengthPrefix(contents.byteLength));
    hash.update(contents);
  }

  return {
    documents: candidates.length,
    bytes,
    manifestFingerprint: hash.digest("hex"),
    files,
  };
}

export function assertPrivateCorpus(actual) {
  for (const key of ["documents", "bytes", "manifestFingerprint"]) {
    if (actual[key] !== PRIVATE_CORPUS[key]) {
      throw new Error(
        `Private corpus ${key} mismatch: expected ${PRIVATE_CORPUS[key]}, got ${actual[key]}`,
      );
    }
  }
}

async function findCandidates(root, directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];

  for (const entry of entries.sort((left, right) => compare(left.name, right.name))) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await findCandidates(root, absolutePath));
    } else if (
      entry.isFile()
      && entry.name.endsWith(".md")
      && entry.name !== "index.md"
      && entry.name !== "log.md"
    ) {
      result.push({
        absolutePath,
        path: relative(root, absolutePath).split(sep).join("/"),
      });
    }
  }

  return result;
}

function lengthPrefix(length) {
  const prefix = Buffer.allocUnsafe(8);
  prefix.writeBigUInt64BE(BigInt(length));
  return prefix;
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
