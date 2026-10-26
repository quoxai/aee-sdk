import { describe, it, expect, vi, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createStdoutSink,
  createFileSink,
  createCustomSink,
  toNdjsonLine,
  AEE,
  createTask,
  type AEEEnvelope,
} from '../src/index.js'

function sampleEnvelope(): AEEEnvelope {
  return createTask('a', 'b', 'ops.ping.check', { k: 1 }, 'CONV_sink_corr_value')
}

const tmpFiles: string[] = []
afterEach(async () => {
  for (const f of tmpFiles.splice(0)) {
    await fs.rm(f, { force: true }).catch(() => {})
  }
})

describe('toNdjsonLine', () => {
  it('serialises one envelope per line with a trailing newline', () => {
    const line = toNdjsonLine(sampleEnvelope())
    expect(line.endsWith('\n')).toBe(true)
    expect(JSON.parse(line.trim()).intent).toBe('ops.ping.check')
  })
})

describe('NaN-poisoned envelope NDJSON parity', () => {
  // The SAME poisoned envelope must serialise to byte-identical, JSON-parseable
  // NDJSON in TypeScript and Python. Non-finite numbers become null.
  const EXPECTED = '{"v":"1","score":null,"nested":{"deep":null}}\n'

  it('replaces non-finite numbers with null and stays byte-parseable', () => {
    const env = { v: '1', score: Number.NaN, nested: { deep: Number.POSITIVE_INFINITY } } as unknown as AEEEnvelope
    const line = toNdjsonLine(env)
    expect(line).toBe(EXPECTED)
    expect(() => JSON.parse(line)).not.toThrow()
    expect(JSON.parse(line)).toEqual({ v: '1', score: null, nested: { deep: null } })
  })
})

describe('stdout sink', () => {
  it('writes a JSON line via the supplied writer', () => {
    const lines: string[] = []
    const sink = createStdoutSink({ write: (l) => lines.push(l) })
    sink(sampleEnvelope())
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0].trim()).type).toBe('task')
  })
})

describe('file sink', () => {
  it('appends NDJSON and creates missing parent directories', async () => {
    const dir = path.join(os.tmpdir(), `aee-sink-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const file = path.join(dir, 'nested', 'envelopes.ndjson')
    tmpFiles.push(dir)
    const sink = createFileSink({ path: file })
    await sink(sampleEnvelope())
    await sink(sampleEnvelope())
    const content = await fs.readFile(file, 'utf8')
    const rows = content.trim().split('\n')
    expect(rows).toHaveLength(2)
    expect(JSON.parse(rows[0]).intent).toBe('ops.ping.check')
  })
})

describe('custom sink', () => {
  it('wraps a function and forwards envelopes', async () => {
    const seen: AEEEnvelope[] = []
    const sink = createCustomSink((e) => { seen.push(e) })
    await sink(sampleEnvelope())
    expect(seen).toHaveLength(1)
  })

  it('rejects a non-function', () => {
    expect(() => createCustomSink(undefined as never)).toThrow(/requires a function/)
  })
})

describe('emit() fire-and-forget error swallowing', () => {
  it('never throws when the sink throws synchronously; routes to onError', async () => {
    const onError = vi.fn()
    const aee = AEE.init({
      agentId: 'x',
      sink: () => { throw new Error('sync boom') },
      onError,
    })
    await expect(aee.emit(sampleEnvelope())).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0].message).toBe('sync boom')
  })

  it('never rejects when the sink rejects asynchronously; routes to onError', async () => {
    const onError = vi.fn()
    const aee = AEE.init({
      agentId: 'x',
      sink: async () => { throw new Error('async boom') },
      onError,
    })
    await expect(aee.emit(sampleEnvelope())).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0].message).toBe('async boom')
  })

  it('does not break emission when onError itself throws', async () => {
    const aee = AEE.init({
      agentId: 'x',
      sink: () => { throw new Error('boom') },
      onError: () => { throw new Error('onError boom') },
    })
    await expect(aee.emit(sampleEnvelope())).resolves.toBeUndefined()
  })

  it('resolves the sink config from a name (file) and a function', async () => {
    const seen: AEEEnvelope[] = []
    const aee = AEE.init({ agentId: 'x', sink: 'custom', sinkOptions: { fn: (e) => seen.push(e) } })
    await aee.emit(sampleEnvelope())
    expect(seen).toHaveLength(1)
  })

  it('throws when custom sink is selected without a fn', () => {
    expect(() => AEE.init({ agentId: 'x', sink: 'custom' })).toThrow(/requires sinkOptions.fn/)
  })
})
