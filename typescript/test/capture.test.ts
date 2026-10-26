import { describe, it, expect, vi } from 'vitest'
import { AEE, validate, type AEEEnvelope } from '../src/index.js'

/** An AEE wired to an in-memory sink that records every emitted envelope. */
function memoryAEE(overrides: Partial<Parameters<typeof AEE.init>[0]> = {}) {
  const emitted: AEEEnvelope[] = []
  const aee = AEE.init({
    agentId: 'tester',
    sink: (e) => { emitted.push(e) },
    decisionEvidence: 'standard',
    ...overrides,
  })
  return { aee, emitted }
}

describe('AEE.init', () => {
  it('requires an agentId', () => {
    expect(() => AEE.init({ agentId: '' })).toThrow(/agentId is required/)
  })

  it('creates independent instances (no global state)', () => {
    const a = AEE.init({ agentId: 'a' })
    const b = AEE.init({ agentId: 'b' })
    expect(a.agentId).toBe('a')
    expect(b.agentId).toBe('b')
    expect(a).not.toBe(b)
  })
})

describe('wrap()', () => {
  it('emits a task on enter and a result on success', async () => {
    const { aee, emitted } = memoryAEE()
    const ret = await aee.wrap({ to: 'agent.b', intent: 'ops.do.thing' }, async () => 'value')
    expect(ret).toBe('value')
    expect(emitted).toHaveLength(2)
    expect(emitted[0].type).toBe('task')
    expect(emitted[1].type).toBe('result')
    expect(emitted[0].from).toBe('agent.tester')
    emitted.forEach((e) => expect(validate(e).valid).toBe(true))
  })

  it('threads the result reply_to to the task id and shares corr', async () => {
    const { aee, emitted } = memoryAEE()
    await aee.wrap({ to: 'agent.b', intent: 'ops.do.thing' }, async () => 0)
    const [task, result] = emitted
    expect(result.reply_to).toBe(task.id)
    expect(result.corr).toBe(task.corr)
  })

  it('emits a task then an error on throw, and rethrows the original error', async () => {
    const { aee, emitted } = memoryAEE()
    await expect(
      aee.wrap({ to: 'agent.b', intent: 'ops.do.thing' }, async () => { throw new Error('kaboom') }),
    ).rejects.toThrow('kaboom')
    expect(emitted).toHaveLength(2)
    expect(emitted[0].type).toBe('task')
    expect(emitted[1].type).toBe('error')
    expect(emitted[1].reply_to).toBe(emitted[0].id)
    expect(validate(emitted[1]).valid).toBe(true)
  })

  it('attaches recorded decision evidence to the result payload', async () => {
    const { aee, emitted } = memoryAEE()
    await aee.wrap({ to: 'agent.b', intent: 'ops.do.thing' }, async (ctx) => {
      ctx.recordInput('diff')
      ctx.recordToolCall('linter')
      ctx.recordDecision('approve', 'no blocking issues')
      ctx.recordAction('merged')
      ctx.setConfidence(0.9)
    })
    const result = emitted[1]
    const ev = (result.payload as Record<string, unknown>).decision_evidence as Record<string, unknown>
    expect(ev.decision).toBe('approve')
    expect(ev.inputs_used).toEqual(['diff'])
    expect(ev.context_refs).toBeUndefined() // standard level drops context_refs
  })

  it('omits decision_evidence when level is none', async () => {
    const { aee, emitted } = memoryAEE({ decisionEvidence: 'none' })
    await aee.wrap({ to: 'agent.b', intent: 'ops.do.thing' }, async (ctx) => {
      ctx.recordDecision('x', 'y')
    })
    expect((emitted[1].payload as Record<string, unknown>).decision_evidence).toBeUndefined()
  })

  it('captures raw content only when opted in', async () => {
    const { aee, emitted } = memoryAEE()
    await aee.wrap({ to: 'agent.b', intent: 'ops.do.thing' }, async (ctx) => {
      ctx.recordInput('secret', 'super-secret-value')
      ctx.recordInput('rawname', 'raw-value', { raw: true })
      ctx.recordDecision('d', 'r')
    })
    const ev = (emitted[1].payload as Record<string, unknown>).decision_evidence as Record<string, unknown>
    const inputs = ev.inputs_used as string[]
    expect(inputs).toContain('secret') // metadata only
    expect(inputs.some((i) => i.includes('raw-value'))).toBe(true) // raw opt-in
    expect(inputs.some((i) => i.includes('super-secret-value'))).toBe(false)
  })
})

describe('startSession() / nested wrap corr inheritance', () => {
  it('groups wraps under one session corr', async () => {
    const { aee, emitted } = memoryAEE()
    const session = aee.startSession()
    await aee.wrap({ to: 'agent.b', intent: 'ops.one' }, async () => 0)
    await aee.wrap({ to: 'agent.c', intent: 'ops.two' }, async () => 0)
    session.end()
    const corrs = new Set(emitted.map((e) => e.corr))
    expect(corrs.size).toBe(1)
    expect([...corrs][0]).toBe(session.corr)
  })

  it('nested wraps inherit the enclosing wrap corr, forming a tree', async () => {
    const { aee, emitted } = memoryAEE()
    await aee.wrap({ to: 'agent.b', intent: 'ops.parent' }, async () => {
      await aee.wrap({ to: 'agent.c', intent: 'ops.child' }, async () => 0)
    })
    // task(parent), task(child), result(child), result(parent)
    expect(emitted).toHaveLength(4)
    const corrs = new Set(emitted.map((e) => e.corr))
    expect(corrs.size).toBe(1)
    const parentTask = emitted[0]
    const childTask = emitted[1]
    expect(childTask.corr).toBe(parentTask.corr)
  })

  it('an explicit corr on a wrap overrides inheritance', async () => {
    const { aee, emitted } = memoryAEE()
    aee.startSession('CONV_session_corr_val')
    await aee.wrap({ to: 'agent.b', intent: 'ops.x', corr: 'CONV_explicit_wrap_corr' }, async () => 0)
    expect(emitted[0].corr).toBe('CONV_explicit_wrap_corr')
  })

  it('ending a session is idempotent and restores no active corr', async () => {
    const { aee } = memoryAEE()
    const session = aee.startSession()
    expect(aee.activeCorr).toBe(session.corr)
    session.end()
    session.end()
    expect(aee.activeCorr).toBeUndefined()
  })
})

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('per-wrap decisionEvidence override', () => {
  it('raising to full includes context_refs despite a standard instance default', async () => {
    const { aee, emitted } = memoryAEE({ decisionEvidence: 'standard' })
    await aee.wrap({ to: 'agent.b', intent: 'ops.x', decisionEvidence: 'full' }, async (ctx) => {
      ctx.recordDecision('d', 'r')
      ctx.recordContextRef('store://envelopes/abc')
    })
    const ev = (emitted[1].payload as Record<string, unknown>).decision_evidence as Record<string, unknown>
    expect(ev.context_refs).toEqual(['store://envelopes/abc'])
  })

  it('dropping to none suppresses evidence despite a standard instance default', async () => {
    const { aee, emitted } = memoryAEE({ decisionEvidence: 'standard' })
    await aee.wrap({ to: 'agent.b', intent: 'ops.x', decisionEvidence: 'none' }, async (ctx) => {
      ctx.recordDecision('d', 'r')
    })
    expect((emitted[1].payload as Record<string, unknown>).decision_evidence).toBeUndefined()
  })

  it('falls back to the instance default when no override is given', async () => {
    const { aee, emitted } = memoryAEE({ decisionEvidence: 'standard' })
    await aee.wrap({ to: 'agent.b', intent: 'ops.x' }, async (ctx) => {
      ctx.recordDecision('d', 'r')
      ctx.recordContextRef('store://envelopes/abc')
    })
    const ev = (emitted[1].payload as Record<string, unknown>).decision_evidence as Record<string, unknown>
    expect(ev.context_refs).toBeUndefined() // standard drops context_refs
  })
})

describe('concurrency: corr is isolated per async context (audit scenario)', () => {
  it('a nested wrap under A keeps A corr even while B is active', async () => {
    const { aee } = memoryAEE()
    const bEntered = deferred()
    const captured: { a?: string; b?: string; nested?: string } = {}

    const aPromise = aee.wrap({ to: 'agent.b', intent: 'ops.a' }, async (ctx) => {
      captured.a = ctx.corr
      // Park until B has entered and pushed its corr into the shared instance.
      await bEntered.promise
      // Nested wrap under A while B is still active: must inherit A's corr.
      await aee.wrap({ to: 'agent.c', intent: 'ops.a.child' }, async (nctx) => {
        captured.nested = nctx.corr
      })
    })

    const bCanFinish = deferred()
    const bPromise = aee.wrap({ to: 'agent.d', intent: 'ops.b' }, async (ctx) => {
      captured.b = ctx.corr
      bEntered.resolve()
      await bCanFinish.promise
    })

    await aPromise
    bCanFinish.resolve()
    await bPromise

    expect(captured.nested).toBe(captured.a)
    expect(captured.nested).not.toBe(captured.b)
  })
})

describe('CaptureContext.emit escape hatch', () => {
  it('emits an arbitrary envelope sharing the wrap corr', async () => {
    const { aee, emitted } = memoryAEE()
    await aee.wrap({ to: 'agent.b', intent: 'ops.do.thing' }, async (ctx) => {
      await ctx.emit({ ...emitted[0], type: 'event', corr: 'CONV_will_be_overridden' } as AEEEnvelope)
    })
    const midEvent = emitted.find((e) => e.type === 'event')
    expect(midEvent).toBeDefined()
    expect(midEvent!.corr).toBe(ctxCorr(emitted))
  })
})

function ctxCorr(emitted: AEEEnvelope[]): string {
  return emitted[0].corr
}
