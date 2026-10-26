#!/usr/bin/env node
/**
 * aee-validate: validate AEE envelopes from a file argument or stdin.
 *
 * Accepts a single envelope JSON object, a JSON array of envelopes, or NDJSON
 * (one envelope per line). Validates every envelope against the embedded
 * canonical schema and prints a per-envelope result summary.
 *
 * Exit codes:
 *   0  every envelope is valid
 *   1  at least one envelope is invalid (input parsed fine)
 *   2  input could not be read or is not valid JSON / NDJSON
 *
 * This is the quoxcli-parity surface for the SDK.
 */
import { readFileSync } from 'node:fs'
import { validate } from '../envelope.js'

function readInput(): string | null {
  const fileArg = process.argv[2]
  if (fileArg && fileArg !== '-') {
    try {
      return readFileSync(fileArg, 'utf8')
    } catch (err) {
      process.stderr.write(`aee-validate: cannot read file '${fileArg}': ${(err as Error).message}\n`)
      return null
    }
  }
  try {
    return readFileSync(0, 'utf8') // stdin (fd 0)
  } catch (err) {
    process.stderr.write(`aee-validate: cannot read stdin: ${(err as Error).message}\n`)
    return null
  }
}

/** Parse the input into a list of envelopes, or null when it is unreadable. */
function parseEnvelopes(text: string): unknown[] | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  // Whole-document JSON first (single object or array of envelopes).
  try {
    const doc = JSON.parse(trimmed)
    return Array.isArray(doc) ? doc : [doc]
  } catch {
    // Fall back to NDJSON: one JSON value per non-empty line.
    const out: unknown[] = []
    for (const line of trimmed.split('\n')) {
      const l = line.trim()
      if (!l) continue
      try {
        out.push(JSON.parse(l))
      } catch {
        return null // an unparseable line means the input is unreadable
      }
    }
    return out.length ? out : null
  }
}

function main(): number {
  const text = readInput()
  if (text === null) return 2

  const envelopes = parseEnvelopes(text)
  if (!envelopes) {
    process.stderr.write('aee-validate: input is not valid JSON or NDJSON\n')
    return 2
  }

  let invalid = 0
  envelopes.forEach((env, i) => {
    const res = validate(env)
    if (res.valid) {
      process.stdout.write(`${i + 1}: VALID\n`)
    } else {
      invalid++
      process.stdout.write(`${i + 1}: INVALID  ${res.errors.join('; ')}\n`)
    }
  })

  const total = envelopes.length
  process.stdout.write(`summary: ${total - invalid}/${total} valid\n`)
  return invalid > 0 ? 1 : 0
}

process.exit(main())
