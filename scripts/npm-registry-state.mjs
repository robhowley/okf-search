export const NPM_REGISTRY = "https://registry.npmjs.org"

function fail(message) {
  throw new Error(message)
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function parseSemver(version) {
  const match = SEMVER.exec(version ?? "")
  if (!match) fail(`invalid semantic version: ${version}`)
  return {
    release: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split(".") ?? [],
  }
}

function compareNumericIdentifiers(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  return left === right ? 0 : left < right ? -1 : 1
}

export function compareSemver(left, right) {
  const a = parseSemver(left)
  const b = parseSemver(right)
  for (let index = 0; index < 3; index += 1) {
    if (a.release[index] !== b.release[index]) return Math.sign(a.release[index] - b.release[index])
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftPart = a.prerelease[index]
    const rightPart = b.prerelease[index]
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1
    if (leftPart === rightPart) continue
    const leftNumber = /^\d+$/.test(leftPart)
    const rightNumber = /^\d+$/.test(rightPart)
    if (leftNumber && rightNumber) return compareNumericIdentifiers(leftPart, rightPart)
    if (leftNumber !== rightNumber) return leftNumber ? -1 : 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

export async function packagePublicationPolicy(name, version, fetchImpl = fetch) {
  if (typeof name !== "string" || name.length === 0) fail("package name is required")
  parseSemver(version)

  let response
  const url = `${NPM_REGISTRY}/${encodeURIComponent(name)}`
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      redirect: "error",
    })
  } catch (error) {
    fail(`npm registry lookup for ${name} failed: ${error instanceof Error ? error.message : error}`)
  }
  if (response.status === 404) return { state: "unpublished", distTag: "latest" }
  if (response.status !== 200) fail(`npm registry lookup for ${name} returned HTTP ${response.status}`)

  let packument
  try {
    packument = await response.json()
  } catch {
    fail(`npm registry returned malformed JSON for ${name}`)
  }
  if (!packument || typeof packument !== "object" || Array.isArray(packument)) {
    fail(`npm registry returned malformed metadata for ${name}`)
  }

  const exact = packument.versions?.[version]
  const latest = packument["dist-tags"]?.latest
  if (exact !== undefined) {
    if (latest !== undefined) parseSemver(latest)
    return { state: "published", distTag: latest === version ? "latest" : null }
  }

  if (latest !== undefined && compareSemver(latest, version) > 0) {
    fail(`refusing to publish ${name}@${version}: latest is newer (${latest})`)
  }
  return { state: "unpublished", distTag: "latest" }
}
