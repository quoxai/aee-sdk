/**
 * Capture layer: the one stateful convenience over the pure envelope
 * functions. `AEE.init(config)` returns an instance with NO global state, so
 * multiple instances coexist. `wrap()` emits a `task` on enter and a
 * `result`/`error` on exit, threading corr/reply_to automatically. Nested
 * wraps inherit the enclosing corr; `startSession()` groups a set of wraps
 * under one corr.
 *
 * Privacy: `record*` captures names/locators/metadata only. Raw content is an
 * explicit per-call opt-in (`{ raw: true }`).
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import {
  createTask,
  createResult,
  createError,
  type AEEEnvelope,
  type Priority,
} from './envelope.js'
import { prefixedUlid } from './ulid.js'
import {
  DecisionEvidenceBuilder,
  type EvidenceLevel,
  type DecisionEvidence,
} from './evidence.js'
import {
  createStdoutSink,
  createFileSink,
  createCustomSink,
  type Sink,
  type FileSinkOptions,
  type StdoutSinkOptions,
} from './sinks/index.js'

export type SinkConfig = 'stdout' | 'file' | 'custom' | Sink

export interface AEEConfig {
  /** Agent identity; `from` defaults to `agent.<agentId>`. */
  agentId: string
  /** Named sink or a custom function. Defaults to `stdout`. */
  sink?: SinkConfig
  /** Options for the named sink (path for file, writer for stdout, fn for custom). */
  sinkOptions?: FileSinkOptions & StdoutSinkOptions & { fn?: Sink }
  /** Decision-evidence level for wrap()-produced results. Defaults to `standard`. */
  decisionEvidence?: EvidenceLevel
  /** Called when a sink or evidence build fails. emit() never throws. */
  onError?: (err: Error, envelope?: AEEEnvelope) => void
}

export interface WrapSpec {
  /** Recipient identifier. */
  to: string
  /** Namespaced intent for the task. */
  intent: string
  /** Task payload (metadata only unless you opt into raw). */
  payload?: Record<string, unknown>
  /** Override the default `agent.<agentId>` sender. */
  from?: string
  /** Explicit corr; otherwise inherits the active session/wrap corr, else minted. */
  corr?: string
  /** Task priority (default `normal`). */
  priority?: Priority
  /**
   * Per-wrap decision-evidence level, overriding the instance default for this
   * wrap only (spec section 13.2). Honours the same `requires` semantics at the
   * manual level: raise to `full` to include `context_refs`, drop to `none` to
   * suppress evidence entirely.
   */
  decisionEvidence?: EvidenceLevel
}

export interface RecordOptions {
  /** Opt in to capturing raw content alongside the name/locator. Default false. */
  raw?: boolean
}

export interface Session {
  corr: string
  end(): void
}

/** Per-wrap recording surface. Feeds the decision-evidence builder. */
export class CaptureContext {
  readonly task: AEEEnvelope
  readonly corr: string
  private readonly builder: DecisionEvidenceBuilder
  private readonly aee: AEE

  constructor(task: AEEEnvelope, builder: DecisionEvidenceBuilder, aee: AEE) {
    this.task = task
    this.corr = task.corr
    this.builder = builder
    this.aee = aee
  }

  recordInput(name: string, descriptor?: unknown, options: RecordOptions = {}): this {
    if (options.raw && descriptor !== undefined) {
      this.builder.recordInput(`${name}=${safeStringify(descriptor)}`)
    } else {
      this.builder.recordInput(name)
    }
    return this
  }

  recordToolCall(name: string, meta?: unknown, options: RecordOptions = {}): this {
    if (options.raw && meta !== undefined) {
      this.builder.recordToolCall(`${name}=${safeStringify(meta)}`)
    } else {
      this.builder.recordToolCall(name)
    }
    return this
  }

  recordContextRef(locator: string): this {
    this.builder.recordContextRef(locator)
    return this
  }

  recordDecision(decision: string, reasonSummary?: string): this {
    this.builder.recordDecision(decision, reasonSummary)
    return this
  }

  recordAction(actionTaken: string): this {
    this.builder.recordAction(actionTaken)
    return this
  }

  setConfidence(confidence: number): this {
    this.builder.setConfidence(confidence)
    return this
  }

  /** Escape hatch: emit an arbitrary envelope mid-wrap, sharing this wrap's corr. */
  emit(envelope: AEEEnvelope): Promise<void> {
    const shared: AEEEnvelope = { ...envelope, corr: this.corr }
    return this.aee.emit(shared)
  }

  /** Internal: builds the level-filtered evidence for this wrap. */
  buildEvidence(level: EvidenceLevel): DecisionEvidence | null {
    return this.builder.build(level)
  }
}

export class AEE {
  readonly agentId: string
  private readonly sink: Sink
  private readonly evidenceLevel: EvidenceLevel
  private readonly onError: (err: Error, envelope?: AEEEnvelope) => void
  /**
   * The active corr stack, held per async execution context via
   * AsyncLocalStorage so concurrent/overlapping wraps NEVER steal each other's
   * corr. Each logical async context sees only its own inherited stack; a
   * nested wrap under task A inherits A's corr even while an unrelated task B is
   * active on the same instance. The store is an immutable snapshot: `wrap()`
   * runs its body inside a fresh `run([...parent, corr])` scope, and
   * `startSession()` uses `enterWith` to extend the current context's stack.
   */
  private readonly corrStorage = new AsyncLocalStorage<readonly string[]>()

  private constructor(config: AEEConfig) {
    if (!config || !config.agentId) {
      throw new Error('AEE.init: config.agentId is required')
    }
    this.agentId = config.agentId
    this.evidenceLevel = config.decisionEvidence || 'standard'
    this.onError = config.onError || (() => {})
    this.sink = resolveSink(config)
  }

  /** Creates a new, independent AEE instance. No global state. */
  static init(config: AEEConfig): AEE {
    return new AEE(config)
  }

  /** The corr currently in effect (session or enclosing wrap), if any. */
  get activeCorr(): string | undefined {
    const stack = this.corrStorage.getStore()
    return stack && stack.length ? stack[stack.length - 1] : undefined
  }

  /**
   * Emits an envelope through the configured sink. Fire-and-forget: this
   * NEVER throws and NEVER rejects, sink failures go to `onError`.
   */
  async emit(envelope: AEEEnvelope): Promise<void> {
    try {
      await this.sink(envelope)
    } catch (err) {
      this.reportError(err, envelope)
    }
  }

  /** Opens a correlation session. Wraps created while open inherit its corr. */
  startSession(corr?: string): Session {
    const sessionCorr = corr || prefixedUlid('CONV')
    const parent = this.corrStorage.getStore() ?? []
    // enterWith extends the CURRENT async context's stack (and its descendants)
    // without a wrapping callback, so wraps created later in this context
    // inherit the session corr while other contexts stay untouched.
    this.corrStorage.enterWith([...parent, sessionCorr])
    let ended = false
    return {
      corr: sessionCorr,
      end: () => {
        if (ended) return
        ended = true
        const cur = this.corrStorage.getStore() ?? []
        const idx = cur.lastIndexOf(sessionCorr)
        const next = idx === -1 ? cur : [...cur.slice(0, idx), ...cur.slice(idx + 1)]
        this.corrStorage.enterWith(next)
      },
    }
  }

  /**
   * Runs `fn`, emitting a `task` before and a `result` (or `error` on throw)
   * after. `fn` receives a CaptureContext for recording decision evidence.
   * The wrap's corr is inherited by any nested wraps.
   */
  async wrap<T>(spec: WrapSpec, fn: (ctx: CaptureContext) => T | Promise<T>): Promise<T> {
    const from = spec.from || `agent.${this.agentId}`
    const parent = this.corrStorage.getStore() ?? []
    const corr = spec.corr || (parent.length ? parent[parent.length - 1] : undefined)
    const level = spec.decisionEvidence ?? this.evidenceLevel
    const options = spec.priority ? { priority: spec.priority } : {}

    const task = createTask(from, spec.to, spec.intent, spec.payload || {}, corr, options)
    await this.emit(task)

    const builder = new DecisionEvidenceBuilder((err) => this.reportError(err, task))
    const ctx = new CaptureContext(task, builder, this)

    // Run the body inside a fresh async-context scope carrying this wrap's corr
    // appended to the inherited stack. Concurrent wraps get disjoint scopes, so
    // a nested wrap here can only ever see THIS wrap's corr, never a sibling's.
    const childStack = [...parent, task.corr]
    return this.corrStorage.run(childStack, async () => {
      try {
        const value = await fn(ctx)
        const evidence = ctx.buildEvidence(level)
        const payload: Record<string, unknown> = {}
        if (evidence) payload.decision_evidence = evidence
        const result = createResult(task, payload)
        await this.emit(result)
        return value
      } catch (err) {
        const evidence = ctx.buildEvidence(level)
        const message = err instanceof Error ? err.message : String(err)
        const errorEnv = createError(task, {
          code: (err as { code?: string })?.code || 'WRAP_ERROR',
          message,
          details: evidence ? { decision_evidence: evidence } : {},
        })
        await this.emit(errorEnv)
        throw err
      }
    })
  }

  private reportError(err: unknown, envelope?: AEEEnvelope): void {
    try {
      this.onError(err instanceof Error ? err : new Error(String(err)), envelope)
    } catch {
      // An onError that itself throws must not break emission.
    }
  }
}

function resolveSink(config: AEEConfig): Sink {
  const sink = config.sink || 'stdout'
  const opts = config.sinkOptions || {}
  if (typeof sink === 'function') return sink
  switch (sink) {
    case 'stdout':
      return createStdoutSink(opts)
    case 'file':
      return createFileSink(opts)
    case 'custom':
      if (!opts.fn) throw new Error("sink 'custom' requires sinkOptions.fn")
      return createCustomSink(opts.fn)
    default:
      throw new Error(`Unknown sink: ${String(sink)}`)
  }
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return String(value)
  }
}
