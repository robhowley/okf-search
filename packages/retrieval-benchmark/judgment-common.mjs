import { createHash } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

const MANIFEST_VERSION = 1
const fail = (text) => { throw new Error(text) }
const errorText = (error) => error instanceof Error ? error.message : String(error)
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`)
  return value
}
function string(value, label, empty = false) {
  if (typeof value !== "string" || (!empty && value.trim() === "")) {
    fail(`${label} must be${empty ? "" : " a non-empty"} string`)
  }
  return value
}
function hash(value) {
  const bytes = Buffer.isBuffer(value) ? value : JSON.stringify(value)
  return createHash("sha256").update(bytes).digest("hex")
}
function ref(section) {
  return { backend: section.backend, documentId: section.document.id, sectionId: section.section.id }
}
const refKey = (value) => JSON.stringify([value.backend, value.documentId, value.sectionId])
async function readManifest(path) {
  let bytes, raw
  try { bytes = await readFile(path) } catch (error) { fail(`cannot read ${path}: ${errorText(error)}`) }
  try { raw = JSON.parse(bytes.toString("utf8")) } catch (error) { fail(`${path} is not valid JSON: ${errorText(error)}`) }
  object(raw, "manifest")
  if (raw.schemaVersion !== MANIFEST_VERSION) fail(`manifest schemaVersion must be ${MANIFEST_VERSION}`)
  object(raw.corpus, "manifest.corpus")
  if (!Array.isArray(raw.sections) || !raw.sections.length) fail("manifest.sections must be a non-empty array")

  const sections = raw.sections.map((entry, index) => {
    const label = `sections[${index}]`, value = object(entry, label)
    const document = object(value.document, `${label}.document`)
    const section = object(value.section, `${label}.section`)
    const metadata = document.metadata ?? {}, headingAncestry = section.headingAncestry ?? []
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) fail(`${label}.document.metadata must be an object`)
    if (!Array.isArray(headingAncestry) || headingAncestry.some((item) => typeof item !== "string")) fail(`${label}.section.headingAncestry must be an array of strings`)
    return {
      backend: string(value.backend, `${label}.backend`),
      document: { id: string(document.id, `${label}.document.id`), path: string(document.path, `${label}.document.path`), title: string(document.title ?? "", `${label}.document.title`, true), metadata },
      section: { id: string(section.id, `${label}.section.id`), content: string(section.content, `${label}.section.content`, true), headingAncestry },
    }
  })
  const seen = new Set()
  for (const section of sections) {
    const key = refKey(ref(section))
    if (seen.has(key)) fail(`duplicate section identity: ${key}`)
    seen.add(key)
  }
  return { corpus: raw.corpus, sections, inputSha256: hash(bytes) }
}

const sectionsByKey = (sections) => new Map(sections.map((section) => [refKey(ref(section)), section]))
function checkedRef(value, sectionMap, label) {
  const input = object(value, label)
  const result = { backend: string(input.backend, `${label}.backend`), documentId: string(input.documentId, `${label}.documentId`), sectionId: string(input.sectionId, `${label}.sectionId`) }
  if (!sectionMap.has(refKey(result))) fail(`${label} is not an input section`)
  return result
}

function validateBatch(raw, sectionMap, inventory, queryCount, saved = false) {
  const batch = object(raw, "query batch")
  if (!Array.isArray(batch.queries) || batch.queries.length !== queryCount) fail(`query batch must contain exactly ${queryCount} queries`)
  const paths = new Map(inventory.map((entry) => [refKey(entry.sectionRef), entry.path]))
  const bundlePaths = new Set(inventory.map((entry) => entry.path))
  if (!Array.isArray(batch.reads)) fail("query batch reads must be an array")
  const reads = batch.reads.map((value) => {
    const read = object(value, "read observation")
    return { path: string(read.path, "read.path"), text: string(read.text, "read.text", true) }
  })
  const seen = new Set()
  const queries = batch.queries.map((value, index) => {
    const id = `q-${String(index + 1).padStart(4, "0")}`, input = object(value, id)
    if (saved && input.id !== id) fail(`query ${id} is missing or out of order`)
    const query = string(input.query, `${id}.query`).trim()
    const normalized = query.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ")
    if (seen.has(normalized)) fail(`duplicate query text: ${query}`)
    seen.add(normalized)
    if (!Array.isArray(input.supportingSections) || !input.supportingSections.length) fail(`${id} needs supporting sections`)
    const supportingSections = input.supportingSections.map((value) => {
      const support = object(value, `${id} support`)
      const sectionRef = checkedRef(support.sectionRef, sectionMap, `${id}.sectionRef`)
      const section = sectionMap.get(refKey(sectionRef)), path = paths.get(refKey(sectionRef))
      if (!Array.isArray(support.evidenceQuotes) || !support.evidenceQuotes.length) fail(`${id} support needs evidence quotes`)
      const evidenceQuotes = support.evidenceQuotes.map((value) => {
        const quote = string(value, `${id} evidence quote`)
        if (!section.section.content.includes(quote)) fail(`${id} evidence quote is not in the referenced section body`)
        if (!reads.some((read) => read.path === path && read.text.includes(quote))) fail(`${id} evidence quote was not inspected with read`)
        return quote
      })
      return { sectionRef, evidenceQuotes }
    })
    return { id, query, topic: string(input.topic, `${id}.topic`), supportingSections }
  })
  // Retain only indexed-file reads as auditable generation provenance.
  return { queries, coverageNotes: string(batch.coverageNotes, "coverageNotes"),
    reads: reads.filter((read) => bundlePaths.has(read.path)) }
}

async function save(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8")
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => {}); throw error
  }
}

async function readJson(path, optional = false) {
  let bytes
  try { bytes = await readFile(path) } catch (error) {
    if (optional && error.code === "ENOENT") return null
    fail(`cannot read ${path}: ${errorText(error)}`)
  }
  try { return { value: object(JSON.parse(bytes.toString("utf8")), path), sha256: hash(bytes) } }
  catch (error) { fail(`${path} is not valid JSON: ${errorText(error)}`) }
}
function checkArtifact(value, kind, hashes, versionKey) {
  if (value.kind !== kind || value[versionKey] !== 1) fail(`unsupported ${kind} version`)
  for (const [key, expected] of Object.entries(hashes)) {
    if (value.hashes?.[key] !== expected) fail(`${kind} ${key} does not match`)
  }
}
async function rejectLegacy(outputDirectory) {
  if (await readJson(`${outputDirectory}/checkpoint.json`, true)) fail("unsupported combined checkpoint; use a new output directory")
  const judgments = await readJson(`${outputDirectory}/judgments.json`, true)
  if (judgments) checkArtifact(judgments.value, "judgments", {}, "outputVersion")
}
const modelRuntimes = new Map()
async function getModelRuntime(provider, modelId) {
  const key = `${provider}/${modelId}`
  if (!modelRuntimes.has(key)) {
    const promise = import("@earendil-works/pi-coding-agent").then(async ({ ModelRuntime }) => {
      const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false })
      const model = runtime.getModel(provider, modelId)
      if (!model || model.api !== "openai-codex-responses") {
        fail(`installed OpenAI Codex model is unavailable: ${provider}/${modelId}`)
      }
      return { runtime, model }
    })
    modelRuntimes.set(key, promise)
  }
  return modelRuntimes.get(key)
}


export { fail, errorText, object, string, hash, ref, refKey, readManifest, sectionsByKey, checkedRef, validateBatch, save, readJson, checkArtifact, rejectLegacy, getModelRuntime }
