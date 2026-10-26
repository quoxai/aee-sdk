import { describe, it, expect, vi } from 'vitest'
import {
  DecisionEvidenceBuilder,
  filterEvidence,
  validateAgainstSchema,
  DECISION_EVIDENCE_SCHEMA,
  type DecisionEvidence,
} from '../src/index.js'

function fullBuilder(onError?: (e: Error) => void) {
  const b = new DecisionEvidenceBuilder(onError)
  b.recordInput('backup-host-01 job log')
    .recordInput('compute-node-02 health check')
    .recordContextRef('store://envelopes/abc')
    .recordToolCall('ssh.exec')
    .recordToolCall('pbs.job.list')
    .recordDecision('PARTIAL_FAILURE', 'compute-node-02 refused connection')
    .recordAction('Returned failed node details')
    .setConfidence(0.92)
  return b
}

describe('DecisionEvidenceBuilder levels', () => {
  it('none yields null', () => {
    expect(fullBuilder().build('none')).toBeNull()
  })

  it('minimal yields decision + reason_summary only', () => {
    expect(fullBuilder().build('minimal')).toEqual({
      decision: 'PARTIAL_FAILURE',
      reason_summary: 'compute-node-02 refused connection',
    })
  })

  it('standard yields all fields except context_refs', () => {
    const e = fullBuilder().build('standard') as DecisionEvidence
    expect(e.context_refs).toBeUndefined()
    expect(e.inputs_used).toEqual(['backup-host-01 job log', 'compute-node-02 health check'])
    expect(e.tools_used).toEqual(['ssh.exec', 'pbs.job.list'])
    expect(e.decision).toBe('PARTIAL_FAILURE')
    expect(e.action_taken).toBe('Returned failed node details')
    expect(e.confidence).toBe(0.92)
  })

  it('full yields all fields including context_refs', () => {
    const e = fullBuilder().build('full') as DecisionEvidence
    expect(e.context_refs).toEqual(['store://envelopes/abc'])
    expect(e.inputs_used).toBeDefined()
  })

  it('returns null when nothing was recorded', () => {
    expect(new DecisionEvidenceBuilder().build('full')).toBeNull()
    expect(new DecisionEvidenceBuilder().isEmpty()).toBe(true)
  })

  it('drops out-of-range confidence with a warning; emitted evidence stays schema-valid', () => {
    const onError = vi.fn()
    const b = new DecisionEvidenceBuilder(onError)
    b.recordDecision('d', 'r').setConfidence(1.5)
    const e = b.build('standard') as DecisionEvidence
    expect(onError).toHaveBeenCalled()
    expect(onError.mock.calls[0][0].message).toMatch(/out-of-range|dropped/)
    expect(e.confidence).toBeUndefined()
    expect(e.decision).toBe('d')
    expect(validateAgainstSchema(DECISION_EVIDENCE_SCHEMA, e).valid).toBe(true)
  })

  it('rejects NaN confidence with a warning and drops it (never emits invalid evidence)', () => {
    const onError = vi.fn()
    const b = new DecisionEvidenceBuilder(onError)
    b.recordDecision('d', 'r').setConfidence(Number.NaN)
    const e = b.build('standard') as DecisionEvidence
    expect(onError).toHaveBeenCalled()
    expect(onError.mock.calls[0][0].message).toMatch(/non-finite|NaN/i)
    expect(e.confidence).toBeUndefined()
    expect(validateAgainstSchema(DECISION_EVIDENCE_SCHEMA, e).valid).toBe(true)
  })

  it('rejects Infinity confidence with a warning and drops it', () => {
    const onError = vi.fn()
    const b = new DecisionEvidenceBuilder(onError)
    b.recordDecision('d', 'r').setConfidence(Number.POSITIVE_INFINITY)
    const e = b.build('standard') as DecisionEvidence
    expect(onError).toHaveBeenCalled()
    expect(e.confidence).toBeUndefined()
    expect(validateAgainstSchema(DECISION_EVIDENCE_SCHEMA, e).valid).toBe(true)
  })

  it('returns null when a lone invalid confidence was the only recorded field', () => {
    const onError = vi.fn()
    const b = new DecisionEvidenceBuilder(onError)
    b.setConfidence(Number.NaN)
    expect(b.build('standard')).toBeNull()
    expect(onError).toHaveBeenCalled()
  })
})

describe('filterEvidence', () => {
  const full = {
    inputs_used: ['a'],
    context_refs: ['c'],
    tools_used: ['t'],
    decision: 'd',
    reason_summary: 'r',
    action_taken: 'act',
    confidence: 0.5,
  }

  it('none yields null', () => {
    expect(filterEvidence({ ...full }, 'none')).toBeNull()
  })

  it('standard drops context_refs', () => {
    const e = filterEvidence({ ...full }, 'standard') as DecisionEvidence
    expect(e.context_refs).toBeUndefined()
    expect(e.decision).toBe('d')
  })

  it('drops unknown fields and warns via onError', () => {
    const onError = vi.fn()
    const e = filterEvidence({ ...full, bogus: 'x' } as never, 'full', onError)
    expect((e as Record<string, unknown>).bogus).toBeUndefined()
    expect(onError).toHaveBeenCalled()
    expect(onError.mock.calls[0][0].message).toMatch(/dropped unknown field/)
  })

  it('returns null when the filtered result is empty', () => {
    expect(filterEvidence({ context_refs: ['c'] } as DecisionEvidence, 'minimal')).toBeNull()
  })
})
