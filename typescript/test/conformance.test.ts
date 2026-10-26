import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import {
  validate,
  filterEvidence,
  AEE_V1_SCHEMA,
  DECISION_EVIDENCE_SCHEMA,
  type EvidenceLevel,
  type DecisionEvidence,
} from '../src/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const conformanceDir = path.resolve(here, '../../conformance')
const fixturesDir = path.join(conformanceDir, 'fixtures')

function loadJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function filesIn(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
}

describe('conformance: valid fixtures (the cross-language contract)', () => {
  const dir = path.join(fixturesDir, 'valid')
  const files = filesIn(dir)

  it('has at least 15 valid fixtures', () => {
    expect(files.length).toBeGreaterThanOrEqual(15)
  })

  for (const file of files) {
    it(`${file} validates as a conformant envelope`, () => {
      const fixture = loadJson(path.join(dir, file)) as { envelope: unknown }
      const result = validate(fixture.envelope)
      expect(result.errors).toEqual([])
      expect(result.valid).toBe(true)
    })
  }
})

describe('conformance: invalid fixtures (each violates one named MUST)', () => {
  const dir = path.join(fixturesDir, 'invalid')
  const files = filesIn(dir)

  it('has at least 20 invalid fixtures', () => {
    expect(files.length).toBeGreaterThanOrEqual(20)
  })

  for (const file of files) {
    it(`${file} is rejected`, () => {
      const fixture = loadJson(path.join(dir, file)) as { envelope: unknown; violates: string }
      expect(fixture.violates, `${file} must name the violated rule`).toBeTruthy()
      expect(validate(fixture.envelope).valid).toBe(false)
    })
  }
})

describe('conformance: evidence-levels matrix', () => {
  const dir = path.join(fixturesDir, 'evidence-levels')
  const files = filesIn(dir)

  it('has evidence-level fixtures', () => {
    expect(files.length).toBeGreaterThanOrEqual(4)
  })

  for (const file of files) {
    it(`${file} filters to the expected evidence`, () => {
      const fx = loadJson(path.join(dir, file)) as {
        level: EvidenceLevel
        input: DecisionEvidence & Record<string, unknown>
        expected: DecisionEvidence | null
      }
      const got = filterEvidence({ ...fx.input }, fx.level)
      expect(got).toEqual(fx.expected)
    })
  }
})

describe('conformance: aee.md §7 recommended conformance bullets', () => {
  const validDir = path.join(fixturesDir, 'valid')

  it('accepts the sample messages from the spec §4', () => {
    for (const file of ['01-spec-section-4.1-task.json', '02-spec-section-4.2-result.json', '03-spec-section-4.3-error.json']) {
      const fx = loadJson(path.join(validDir, file)) as { envelope: unknown }
      expect(validate(fx.envelope).valid).toBe(true)
    }
  })

  it('rejects messages missing required fields', () => {
    const fx = loadJson(path.join(fixturesDir, 'invalid', '09-missing-priority.json')) as { envelope: unknown }
    expect(validate(fx.envelope).valid).toBe(false)
  })

  it('enforces reply_to for result and error', () => {
    for (const file of ['14-result-reply_to-null.json', '15-error-reply_to-null.json']) {
      const fx = loadJson(path.join(fixturesDir, 'invalid', file)) as { envelope: unknown }
      expect(validate(fx.envelope).valid).toBe(false)
    }
  })

  it('documents the orphan own-id reply_to fallback as an explicit edge case', () => {
    const fx = loadJson(path.join(validDir, '12-error-orphan-reply_to-self-fallback.json')) as {
      _comment?: string
      envelope: { id: string; reply_to: string; type: string }
    }
    // The renamed fixture carries a _comment explaining the edge-case nature.
    expect(fx._comment).toBeTruthy()
    expect(fx.envelope.type).toBe('error')
    // Self-referential reply_to: the last-resort fallback for an orphan error.
    expect(fx.envelope.reply_to).toBe(fx.envelope.id)
    expect(validate(fx.envelope).valid).toBe(true)
  })

  it('preserves unknown fields (does not strip by default)', () => {
    const fx = loadJson(path.join(validDir, '09-task-with-unknown-extension-field.json')) as {
      envelope: Record<string, unknown>
    }
    expect(fx.envelope.x_vendor_field).toBeDefined()
    expect(validate(fx.envelope).valid).toBe(true)
  })
})

describe('schema drift: embedded schemas match the vendored conformance copies', () => {
  it('embedded AEE_V1_SCHEMA equals conformance/aee-v1.schema.json', () => {
    const vendored = loadJson(path.join(conformanceDir, 'aee-v1.schema.json'))
    expect(AEE_V1_SCHEMA).toEqual(vendored)
  })

  it('embedded DECISION_EVIDENCE_SCHEMA equals conformance/decision-evidence.schema.json', () => {
    const vendored = loadJson(path.join(conformanceDir, 'decision-evidence.schema.json'))
    expect(DECISION_EVIDENCE_SCHEMA).toEqual(vendored)
  })
})
