/**
 * Schema drift check.
 *
 * Byte-compares the vendored conformance schemas against the CANONICAL copies
 * in the aee spec repo. The canonical source is, in order of preference:
 *
 *   1. the local sibling checkout at ../aee/schemas (when present), or
 *   2. https://raw.githubusercontent.com/quoxai/aee/main/schemas/ (in CI).
 *
 * Exit codes:
 *   0  all reachable schemas match  (also: cleanly SKIPPED when NEITHER source
 *      is reachable, with a notice)
 *   1  drift detected against a reachable canonical copy
 *
 * Zero dependencies: node:fs + global fetch (Node >= 18).
 */
import { readFileSync, existsSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

const SCHEMAS = ['aee-v1.schema.json', 'decision-evidence.schema.json']
const localSpecDir = path.resolve(repoRoot, '..', 'aee', 'schemas')
const REMOTE_BASE = 'https://raw.githubusercontent.com/quoxai/aee/main/schemas/'

async function getCanonical(name) {
  const localPath = path.join(localSpecDir, name)
  if (existsSync(localPath)) {
    return { source: `local ${localPath}`, content: readFileSync(localPath) }
  }
  try {
    const res = await fetch(REMOTE_BASE + name)
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    return { source: `${REMOTE_BASE}${name}`, content: buf }
  } catch {
    return null
  }
}

function firstDiff(a, b) {
  const aLines = a.toString('utf8').split('\n')
  const bLines = b.toString('utf8').split('\n')
  const n = Math.max(aLines.length, bLines.length)
  for (let i = 0; i < n; i++) {
    if (aLines[i] !== bLines[i]) {
      return `line ${i + 1}:\n  vendored:  ${JSON.stringify(aLines[i])}\n  canonical: ${JSON.stringify(bLines[i])}`
    }
  }
  return '(files differ only in length/trailing bytes)'
}

async function main() {
  let anyReachable = false
  let drift = false

  for (const name of SCHEMAS) {
    const vendoredPath = path.join(repoRoot, 'conformance', name)
    if (!existsSync(vendoredPath)) {
      console.error(`DRIFT: vendored schema missing: conformance/${name}`)
      drift = true
      continue
    }
    const vendored = readFileSync(vendoredPath)
    const canonical = await getCanonical(name)
    if (!canonical) {
      console.log(`skip: canonical source for ${name} not reachable`)
      continue
    }
    anyReachable = true
    if (vendored.equals(canonical.content)) {
      console.log(`ok: conformance/${name} matches canonical (${canonical.source})`)
    } else {
      drift = true
      console.error(`DRIFT: conformance/${name} differs from canonical (${canonical.source})`)
      console.error(firstDiff(vendored, canonical.content))
    }
  }

  if (!anyReachable && !drift) {
    console.log(
      'schema-drift: no canonical source reachable (local sibling absent, network unavailable). SKIPPED.',
    )
    process.exit(0)
  }
  if (drift) {
    console.error('schema-drift: FAILED (vendored schemas are out of sync with the canonical spec).')
    process.exit(1)
  }
  console.log('schema-drift: all vendored schemas match the canonical spec.')
  process.exit(0)
}

main()
