/**
 * AEE envelope factory + validation.
 *
 * Ports quox-dashboard `src/lib/aee/envelope.js` + `types.js`, plus the
 * spec deltas required for the SDK to conform to the canonical spec schema
 * (`aee-v1.schema.json`, spec section 6):
 *
 *   - `priority` is emitted with a default of `'normal'` (spec REQUIRED field
 *     the internal lib omitted).
 *   - `reply_to` is conditionally enforced: it MUST be a non-null string for
 *     `result`/`error` envelopes (spec section 3 rule 3). Adopting the
 *     resolution proven in quox-qluster `server/lib/aee.js`, a `result`/`error`
 *     with no explicit predecessor falls back to the envelope's OWN id (root
 *     of its own thread) so it is always schema-valid. For other types
 *     `reply_to` defaults to `null` (spec: SHOULD be null).
 *   - Unknown/extension fields are PRESERVED (spec section 5/7: unknown fields
 *     MUST NOT be stripped), via `...ext` spread on `createEnvelope`.
 *
 * The result: every envelope produced here validates against BOTH the spec
 * schema and the stricter internal validators.
 */

import { ulid, prefixedUlid } from './ulid.js'
import { validateAgainstSchema, type JsonSchema, type ValidationResult } from './schema.js'

export const PROTOCOL_VERSION = '1'
export const ENVELOPE_TYPES = ['task', 'result', 'event', 'error', 'stream'] as const
export const PRIORITY_LEVELS = ['low', 'normal', 'high', 'urgent'] as const

export type EnvelopeType = (typeof ENVELOPE_TYPES)[number]
export type Priority = (typeof PRIORITY_LEVELS)[number]

export interface TraceContext {
  trace_id?: string
  span_id?: string
}

export interface AEEEnvelope {
  v: string
  id: string
  ts: string
  type: EnvelopeType
  from: string
  to: string
  intent: string
  corr: string
  reply_to: string | null
  priority: Priority
  payload: Record<string, unknown>
  trace?: TraceContext | null
  requires?: Record<string, unknown> | null
  sig?: Record<string, unknown> | string | null
  // Unknown/extension fields are preserved.
  [key: string]: unknown
}

/**
 * The canonical AEE v1 envelope schema (spec section 6), embedded so the SDK
 * core is self-contained and dependency-free. This is kept byte-for-byte in
 * sync with `conformance/aee-v1.schema.json`; a drift test asserts equality.
 */
export const AEE_V1_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://example.org/aee/aee-v1.schema.json',
  title: 'AEE v1 Envelope',
  type: 'object',
  additionalProperties: true,
  required: ['v', 'id', 'ts', 'type', 'from', 'to', 'intent', 'corr', 'priority', 'payload'],
  properties: {
    v: { type: 'string', const: '1' },
    id: { type: 'string', minLength: 8 },
    ts: { type: 'string', minLength: 10 },
    type: { type: 'string', enum: ['task', 'result', 'event', 'error', 'stream'] },
    from: { type: 'string', minLength: 1 },
    to: { type: 'string', minLength: 1 },
    intent: { type: 'string', minLength: 3 },
    corr: { type: 'string', minLength: 8 },
    reply_to: { type: ['string', 'null'] },
    trace: {
      type: ['object', 'null'],
      additionalProperties: true,
      properties: {
        trace_id: { type: 'string' },
        span_id: { type: 'string' },
      },
    },
    priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
    requires: { type: ['object', 'null'], additionalProperties: true },
    payload: { type: 'object', additionalProperties: true },
    sig: { type: ['object', 'string', 'null'], additionalProperties: true },
  },
  allOf: [
    {
      if: { properties: { type: { enum: ['result', 'error'] } } },
      then: { required: ['reply_to'], properties: { reply_to: { type: 'string', minLength: 8 } } },
    },
  ],
}

export interface CreateEnvelopeParams {
  type: EnvelopeType
  from: string
  to: string
  intent: string
  corr?: string
  replyTo?: string | null
  payload?: Record<string, unknown>
  priority?: Priority
  /**
   * Optional warning hook. Fires when the last-resort own-id `reply_to`
   * fallback is used for an orphan result/error with no predecessor. Not part
   * of the emitted envelope.
   */
  onError?: (err: Error) => void
  // Any additional extension fields (trace, requires, sig, custom) are preserved.
  [key: string]: unknown
}

const RESERVED_KEYS = new Set([
  'type',
  'from',
  'to',
  'intent',
  'corr',
  'replyTo',
  'reply_to',
  'payload',
  'priority',
  'onError',
])

/**
 * Layer-1 primitive: build a fully-formed, spec-conformant envelope.
 * Pure function, no I/O, no state.
 */
export function createEnvelope(params: CreateEnvelopeParams): AEEEnvelope {
  const {
    type,
    from,
    to,
    intent,
    corr,
    replyTo = null,
    payload = {},
    priority = 'normal',
    onError,
    ...ext
  } = params

  const id = ulid()

  // Conditional reply_to (spec section 3 rule 3): result/error MUST be
  // non-null. Adopt the quox-qluster resolution: fall back to own id when no
  // explicit predecessor was supplied. This is a LAST RESORT for orphan
  // results/errors and is surfaced via onError so it is never silent.
  let resolvedReplyTo: string | null
  if (type === 'result' || type === 'error') {
    if (replyTo != null) {
      resolvedReplyTo = replyTo
    } else {
      resolvedReplyTo = id
      onError?.(
        new Error(
          `aee: ${type} envelope has no predecessor; reply_to fell back to its own id ` +
            `(${id}) as a last resort for an orphan ${type}. Supply replyTo to thread it correctly.`,
        ),
      )
    }
  } else {
    resolvedReplyTo = replyTo ?? null
  }

  const envelope: AEEEnvelope = {
    v: PROTOCOL_VERSION,
    id,
    ts: new Date().toISOString(),
    type,
    from,
    to,
    intent,
    corr: corr || prefixedUlid('CONV'),
    reply_to: resolvedReplyTo,
    priority,
    payload,
  }

  // Preserve unknown/extension fields (spec: unknown fields MUST NOT be
  // stripped). Never let an extension key clobber a reserved envelope field.
  for (const [k, val] of Object.entries(ext)) {
    if (!RESERVED_KEYS.has(k) && !(k in envelope)) {
      ;(envelope as Record<string, unknown>)[k] = val
    }
  }

  return envelope
}

export interface EnvelopeOptions {
  priority?: Priority
  [key: string]: unknown
}

/** Creates a TASK envelope (request expecting a response). Mirrors envelope.js:99. */
export function createTask(
  from: string,
  to: string,
  intent: string,
  payload: Record<string, unknown> = {},
  corr?: string,
  options: EnvelopeOptions = {},
): AEEEnvelope {
  return createEnvelope({ type: 'task', from, to, intent, corr, payload, ...options })
}

/**
 * Creates a RESULT envelope (response to a task). Swaps from/to, threads
 * `reply_to` to the task id, and inherits the task's corr. Mirrors
 * envelope.js:125. Result intent defaults to the task intent with a
 * `.query`->`.response` rewrite (a no-op for intents without `.query`, which
 * keeps the spec's same-intent request/response pairing).
 */
export function createResult(
  replyTo: AEEEnvelope,
  payload: Record<string, unknown> = {},
  options: EnvelopeOptions = {},
): AEEEnvelope {
  const responseIntent = replyTo.intent.replace('.query', '.response')
  return createEnvelope({
    type: 'result',
    from: replyTo.to,
    to: replyTo.from,
    intent: responseIntent,
    corr: replyTo.corr,
    replyTo: replyTo.id,
    payload,
    ...options,
  })
}

/** Creates an EVENT envelope (broadcast notification, no reply). Mirrors envelope.js:158. */
export function createEvent(
  from: string,
  intent: string,
  payload: Record<string, unknown> = {},
  corr?: string,
  options: EnvelopeOptions = {},
): AEEEnvelope {
  return createEnvelope({ type: 'event', from, to: 'system', intent, corr, payload, ...options })
}

export interface ErrorDetails {
  code?: string
  message?: string
  details?: Record<string, unknown>
}

/** Creates an ERROR envelope in reply to an envelope. Mirrors envelope.js:186. */
export function createError(
  replyTo: AEEEnvelope,
  error: ErrorDetails,
  options: EnvelopeOptions = {},
): AEEEnvelope {
  return createEnvelope({
    type: 'error',
    from: replyTo.to,
    to: replyTo.from,
    intent: 'aee.protocol.error',
    corr: replyTo.corr,
    replyTo: replyTo.id,
    payload: {
      error_code: error.code || 'UNKNOWN',
      error_message: error.message || 'An unknown error occurred',
      details: error.details || {},
      original_intent: replyTo.intent,
    },
    ...options,
  })
}

/**
 * Validates an envelope against the canonical AEE v1 schema (spec section 6),
 * including the conditional `reply_to` requirement for result/error.
 */
export function validate(envelope: unknown): ValidationResult {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { valid: false, errors: ['Envelope must be a non-null object'] }
  }
  return validateAgainstSchema(AEE_V1_SCHEMA, envelope)
}

/** Type guard: is `obj` a valid AEE envelope? */
export function isAEEEnvelope(obj: unknown): obj is AEEEnvelope {
  return validate(obj).valid
}
