import { describe, it, expect, vi } from 'vitest'
import {
  createEnvelope,
  createTask,
  createResult,
  createEvent,
  createError,
  validate,
  isAEEEnvelope,
  ENVELOPE_TYPES,
  PRIORITY_LEVELS,
  PROTOCOL_VERSION,
  type AEEEnvelope,
} from '../src/index.js'

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

describe('createEnvelope', () => {
  it('sets v/id/ts and mints a corr by default', () => {
    const e = createEnvelope({ type: 'task', from: 'a', to: 'b', intent: 'x.y' })
    expect(e.v).toBe(PROTOCOL_VERSION)
    expect(ULID_RE.test(e.id)).toBe(true)
    expect(Number.isNaN(Date.parse(e.ts))).toBe(false)
    expect(e.corr.startsWith('CONV_')).toBe(true)
  })

  it('defaults priority to normal (spec delta)', () => {
    const e = createEnvelope({ type: 'task', from: 'a', to: 'b', intent: 'x.y' })
    expect(e.priority).toBe('normal')
  })

  it('honours an explicit priority', () => {
    const e = createEnvelope({ type: 'task', from: 'a', to: 'b', intent: 'x.y', priority: 'urgent' })
    expect(e.priority).toBe('urgent')
  })

  it('defaults reply_to to null for task/event/stream', () => {
    for (const type of ['task', 'event', 'stream'] as const) {
      const e = createEnvelope({ type, from: 'a', to: 'b', intent: 'x.y' })
      expect(e.reply_to).toBeNull()
    }
  })

  it('falls back reply_to to own id for result/error with no predecessor (qluster resolution)', () => {
    for (const type of ['result', 'error'] as const) {
      const e = createEnvelope({ type, from: 'a', to: 'b', intent: 'x.y' })
      expect(e.reply_to).toBe(e.id)
      expect(validate(e).valid).toBe(true)
    }
  })

  it('uses an explicit replyTo for result/error when given', () => {
    const e = createEnvelope({ type: 'result', from: 'a', to: 'b', intent: 'x.y', replyTo: '01JFB2R1JZKQ9V3K8W8Y9W1F2A' })
    expect(e.reply_to).toBe('01JFB2R1JZKQ9V3K8W8Y9W1F2A')
  })

  it('warns via onError when the own-id reply_to fallback fires (orphan result/error)', () => {
    for (const type of ['result', 'error'] as const) {
      const onError = vi.fn()
      const e = createEnvelope({ type, from: 'a', to: 'b', intent: 'x.y', onError })
      expect(e.reply_to).toBe(e.id)
      expect(onError).toHaveBeenCalledTimes(1)
      expect(onError.mock.calls[0][0].message).toMatch(/reply_to|own id|orphan/)
    }
  })

  it('does not warn when an explicit replyTo is supplied for result/error', () => {
    const onError = vi.fn()
    createEnvelope({ type: 'result', from: 'a', to: 'b', intent: 'x.y', replyTo: '01JFB2R1JZKQ9V3K8W8Y9W1F2A', onError })
    expect(onError).not.toHaveBeenCalled()
  })

  it('does not carry the onError control field into the envelope', () => {
    const onError = vi.fn()
    const e = createEnvelope({ type: 'result', from: 'a', to: 'b', intent: 'x.y', onError }) as Record<string, unknown>
    expect(e.onError).toBeUndefined()
  })

  it('defaults payload to an empty object', () => {
    const e = createEnvelope({ type: 'task', from: 'a', to: 'b', intent: 'x.y' })
    expect(e.payload).toEqual({})
  })

  it('preserves unknown/extension fields (spec §3 rule 5 / §7)', () => {
    const e = createEnvelope({ type: 'task', from: 'a', to: 'b', intent: 'x.y', trace: { trace_id: 't' }, x_vendor: 42 })
    expect(e.trace).toEqual({ trace_id: 't' })
    expect(e.x_vendor).toBe(42)
  })

  it('never lets an extension field clobber a reserved field', () => {
    const e = createEnvelope({ type: 'task', from: 'a', to: 'b', intent: 'x.y', v: '9', id: 'HACK' } as never)
    expect(e.v).toBe(PROTOCOL_VERSION)
    expect(e.id).not.toBe('HACK')
  })

  it('respects an explicit corr', () => {
    const e = createEnvelope({ type: 'task', from: 'a', to: 'b', intent: 'x.y', corr: 'CONV_explicit_corr_value' })
    expect(e.corr).toBe('CONV_explicit_corr_value')
  })

  it('produces schema-valid envelopes for every type', () => {
    for (const type of ENVELOPE_TYPES) {
      const e = createEnvelope({ type, from: 'a', to: 'b', intent: 'x.y' })
      expect(validate(e).valid).toBe(true)
    }
  })
})

describe('createTask', () => {
  it('creates a valid task', () => {
    const t = createTask('human.adam', 'agent.b', 'ops.do.thing', { k: 1 })
    expect(t.type).toBe('task')
    expect(t.from).toBe('human.adam')
    expect(t.to).toBe('agent.b')
    expect(t.payload).toEqual({ k: 1 })
    expect(t.reply_to).toBeNull()
    expect(validate(t).valid).toBe(true)
  })

  it('accepts a corr and options', () => {
    const t = createTask('a', 'b', 'ops.do.thing', {}, 'CONV_shared_corr_val', { priority: 'high' })
    expect(t.corr).toBe('CONV_shared_corr_val')
    expect(t.priority).toBe('high')
  })
})

describe('createResult', () => {
  const task = createTask('human.adam', 'agent.b', 'ops.status.query', { k: 1 }, 'CONV_result_corr_value')

  it('swaps from/to and threads reply_to to the task id', () => {
    const r = createResult(task, { done: true })
    expect(r.type).toBe('result')
    expect(r.from).toBe(task.to)
    expect(r.to).toBe(task.from)
    expect(r.reply_to).toBe(task.id)
    expect(r.corr).toBe(task.corr)
    expect(validate(r).valid).toBe(true)
  })

  it('rewrites .query -> .response in the intent', () => {
    const r = createResult(task, {})
    expect(r.intent).toBe('ops.status.response')
  })

  it('keeps a non-query intent unchanged', () => {
    const t2 = createTask('a', 'b', 'ops.backup.status.check', {}, 'CONV_result_corr_two')
    const r = createResult(t2, {})
    expect(r.intent).toBe('ops.backup.status.check')
  })
})

describe('createEvent', () => {
  it('broadcasts to system with null reply_to', () => {
    const e = createEvent('agent.monitor', 'obs.metric.report', { cpu: 10 })
    expect(e.type).toBe('event')
    expect(e.to).toBe('system')
    expect(e.reply_to).toBeNull()
    expect(validate(e).valid).toBe(true)
  })
})

describe('createError', () => {
  const task = createTask('human.adam', 'agent.b', 'ops.status.query', {}, 'CONV_error_corr_value')

  it('builds an error envelope replying to the task', () => {
    const err = createError(task, { code: 'E_TIMEOUT', message: 'timed out' })
    expect(err.type).toBe('error')
    expect(err.intent).toBe('aee.protocol.error')
    expect(err.reply_to).toBe(task.id)
    expect(err.from).toBe(task.to)
    expect(err.to).toBe(task.from)
    expect(validate(err).valid).toBe(true)
  })

  it('populates the standard error payload shape', () => {
    const err = createError(task, { code: 'E1', message: 'boom', details: { a: 1 } })
    expect(err.payload).toMatchObject({
      error_code: 'E1',
      error_message: 'boom',
      details: { a: 1 },
      original_intent: 'ops.status.query',
    })
  })

  it('applies sensible defaults for missing code/message', () => {
    const err = createError(task, {})
    expect(err.payload.error_code).toBe('UNKNOWN')
    expect(err.payload.error_message).toBe('An unknown error occurred')
  })
})

describe('validate', () => {
  function goodTask(): AEEEnvelope {
    return createTask('a', 'b', 'ops.ping.check', {}, 'CONV_validate_corr_val')
  }

  it('accepts a well-formed envelope', () => {
    expect(validate(goodTask())).toEqual({ valid: true, errors: [] })
  })

  it('rejects a non-object', () => {
    expect(validate(null).valid).toBe(false)
    expect(validate([]).valid).toBe(false)
    expect(validate('x').valid).toBe(false)
  })

  it('flags a missing required field', () => {
    const e = goodTask() as Record<string, unknown>
    delete e.priority
    const r = validate(e)
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toMatch(/priority/)
  })

  it('flags a bad version const', () => {
    expect(validate({ ...goodTask(), v: '2' }).valid).toBe(false)
  })

  it('flags an out-of-enum type', () => {
    expect(validate({ ...goodTask(), type: 'bogus' }).valid).toBe(false)
  })

  it('flags an out-of-enum priority', () => {
    expect(validate({ ...goodTask(), priority: 'critical' }).valid).toBe(false)
  })

  it('enforces non-null reply_to for result', () => {
    expect(validate({ ...goodTask(), type: 'result', reply_to: null }).valid).toBe(false)
  })

  it('enforces reply_to minLength 8 for error', () => {
    expect(validate({ ...goodTask(), type: 'error', reply_to: 'short' }).valid).toBe(false)
  })

  it('rejects an array payload', () => {
    expect(validate({ ...goodTask(), payload: [] }).valid).toBe(false)
  })

  it('rejects a too-short corr and too-short intent', () => {
    expect(validate({ ...goodTask(), corr: 'short' }).valid).toBe(false)
    expect(validate({ ...goodTask(), intent: 'ab' }).valid).toBe(false)
  })

  it('rejects empty from/to', () => {
    expect(validate({ ...goodTask(), from: '' }).valid).toBe(false)
    expect(validate({ ...goodTask(), to: '' }).valid).toBe(false)
  })

  it('isAEEEnvelope acts as a type guard', () => {
    expect(isAEEEnvelope(goodTask())).toBe(true)
    expect(isAEEEnvelope({})).toBe(false)
  })
})

describe('exported constants', () => {
  it('exposes the type and priority vocabularies', () => {
    expect(ENVELOPE_TYPES).toEqual(['task', 'result', 'event', 'error', 'stream'])
    expect(PRIORITY_LEVELS).toEqual(['low', 'normal', 'high', 'urgent'])
  })
})
