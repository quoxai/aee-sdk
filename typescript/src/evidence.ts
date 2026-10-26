/**
 * Decision-evidence builder (AEE spec section 13).
 *
 * Collects the decision-evidence fragment fields, then emits an object
 * filtered by the configured level per the spec section 13.2 table:
 *
 *   none     -> no evidence at all
 *   minimal  -> decision, reason_summary
 *   standard -> all fields EXCEPT context_refs
 *   full     -> all fields, including context_refs
 *
 * The result is validated against `decision-evidence.schema.json` (embedded
 * below), which has `additionalProperties: false`. Unknown fields are dropped
 * (never forwarded) and each drop is surfaced via the `onError` callback.
 */

import { validateAgainstSchema, type JsonSchema } from './schema.js'

export type EvidenceLevel = 'none' | 'minimal' | 'standard' | 'full'

export interface DecisionEvidence {
  inputs_used?: string[]
  context_refs?: string[]
  tools_used?: string[]
  decision?: string
  reason_summary?: string
  action_taken?: string
  confidence?: number
}

export type EvidenceErrorHandler = (err: Error) => void

/** Embedded copy of `decision-evidence.schema.json` (kept in sync via drift test). */
export const DECISION_EVIDENCE_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://quox.ai/aee/schemas/decision-evidence.schema.json',
  title: 'AEE Decision Evidence Fragment',
  description:
    'Reusable schema fragment for structured decision evidence in AEE result payloads. See AEE spec Section 13.',
  type: 'object',
  properties: {
    inputs_used: {
      type: 'array',
      items: { type: 'string' },
      description: 'Names or identifiers of inputs the agent considered',
    },
    context_refs: {
      type: 'array',
      items: { type: 'string' },
      description: 'Locators or IDs of referenced context (envelopes, documents, tools)',
    },
    tools_used: {
      type: 'array',
      items: { type: 'string' },
      description: 'Tool names invoked during decision-making',
    },
    decision: {
      type: 'string',
      description: 'The decision reached (concise statement)',
    },
    reason_summary: {
      type: 'string',
      description: 'Why this decision was made (1-3 sentences)',
    },
    action_taken: {
      type: 'string',
      description: 'What the agent did as a result',
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'Agent self-assessed confidence (0 = no confidence, 1 = certain)',
    },
  },
  additionalProperties: false,
}

/** The known evidence fields, in canonical order. */
const KNOWN_FIELDS = [
  'inputs_used',
  'context_refs',
  'tools_used',
  'decision',
  'reason_summary',
  'action_taken',
  'confidence',
] as const

/** Fields permitted at each level (section 13.2). */
const LEVEL_FIELDS: Record<EvidenceLevel, Set<string>> = {
  none: new Set(),
  minimal: new Set(['decision', 'reason_summary']),
  standard: new Set([
    'inputs_used',
    'tools_used',
    'decision',
    'reason_summary',
    'action_taken',
    'confidence',
  ]),
  full: new Set(KNOWN_FIELDS),
}

/**
 * Removes an invalid `confidence` from an evidence object in place, warning via
 * `onError`. Non-finite (NaN/Infinity) or out-of-range (outside 0..1) values are
 * dropped so the object always validates against the decision-evidence schema.
 */
function sanitiseConfidence(obj: Record<string, unknown>, onError: EvidenceErrorHandler): void {
  if (!('confidence' in obj)) return
  const c = obj.confidence
  if (typeof c !== 'number' || !Number.isFinite(c)) {
    delete obj.confidence
    onError(new Error(`decision-evidence: dropped non-finite confidence (${String(c)})`))
  } else if (c < 0 || c > 1) {
    delete obj.confidence
    onError(new Error(`decision-evidence: dropped out-of-range confidence ${c} (must be 0..1)`))
  }
}

export class DecisionEvidenceBuilder {
  private inputs: string[] = []
  private contexts: string[] = []
  private tools: string[] = []
  private decisionText?: string
  private reason?: string
  private action?: string
  private conf?: number
  private readonly onError?: EvidenceErrorHandler

  constructor(onError?: EvidenceErrorHandler) {
    this.onError = onError
  }

  recordInput(name: string): this {
    if (name) this.inputs.push(name)
    return this
  }

  recordContextRef(locator: string): this {
    if (locator) this.contexts.push(locator)
    return this
  }

  recordToolCall(name: string): this {
    if (name) this.tools.push(name)
    return this
  }

  recordDecision(decision: string, reasonSummary?: string): this {
    this.decisionText = decision
    if (reasonSummary !== undefined) this.reason = reasonSummary
    return this
  }

  recordAction(actionTaken: string): this {
    this.action = actionTaken
    return this
  }

  setConfidence(confidence: number): this {
    this.conf = confidence
    return this
  }

  /** True if nothing has been recorded yet. */
  isEmpty(): boolean {
    return (
      this.inputs.length === 0 &&
      this.contexts.length === 0 &&
      this.tools.length === 0 &&
      this.decisionText === undefined &&
      this.reason === undefined &&
      this.action === undefined &&
      this.conf === undefined
    )
  }

  /** Assembles the full (unfiltered) evidence object from what was recorded. */
  private assemble(): DecisionEvidence {
    const e: DecisionEvidence = {}
    if (this.inputs.length) e.inputs_used = [...this.inputs]
    if (this.contexts.length) e.context_refs = [...this.contexts]
    if (this.tools.length) e.tools_used = [...this.tools]
    if (this.decisionText !== undefined) e.decision = this.decisionText
    if (this.reason !== undefined) e.reason_summary = this.reason
    if (this.action !== undefined) e.action_taken = this.action
    if (this.conf !== undefined) e.confidence = this.conf
    return e
  }

  /**
   * Builds the level-filtered, schema-valid evidence object.
   *
   * Returns `null` for level `none` (or when nothing was recorded). Unknown
   * fields are dropped and warned via `onError`; a schema violation (e.g. a
   * confidence outside 0..1) also warns via `onError` but the object is still
   * returned so a bad confidence does not silently discard real evidence.
   */
  build(level: EvidenceLevel): DecisionEvidence | null {
    if (level === 'none') return null

    const full = this.assemble()
    const allowed = LEVEL_FIELDS[level]
    const filtered: Record<string, unknown> = {}

    for (const [key, val] of Object.entries(full)) {
      if (allowed.has(key)) {
        filtered[key] = val
      }
    }

    // Drop unknown fields against the schema (defence in depth: assemble()
    // only produces known fields, but a caller subclass could add more).
    for (const key of Object.keys(filtered)) {
      if (!(KNOWN_FIELDS as readonly string[]).includes(key)) {
        delete filtered[key]
        this.warn(new Error(`decision-evidence: dropped unknown field "${key}"`))
      }
    }

    // Confidence integrity: emitted evidence MUST validate against the schema
    // (0 <= confidence <= 1). A non-finite value (NaN/Infinity) or an
    // out-of-range value is DROPPED (never emitted) with an onError warning, so
    // one bad confidence can never produce schema-invalid evidence.
    sanitiseConfidence(filtered, (err) => this.warn(err))

    if (Object.keys(filtered).length === 0) return null

    const result = filtered as DecisionEvidence
    const check = validateAgainstSchema(DECISION_EVIDENCE_SCHEMA, result)
    if (!check.valid) {
      this.warn(new Error(`decision-evidence: schema violation - ${check.errors.join('; ')}`))
    }

    return result
  }

  private warn(err: Error): void {
    if (this.onError) {
      this.onError(err)
    }
  }
}

/**
 * Filters a plain evidence object down to a level and validates it, dropping
 * unknown fields (warning via `onError`). Convenience for callers who already
 * hold a complete evidence object rather than building it incrementally.
 */
export function filterEvidence(
  evidence: DecisionEvidence & Record<string, unknown>,
  level: EvidenceLevel,
  onError?: EvidenceErrorHandler,
): DecisionEvidence | null {
  if (level === 'none') return null
  const allowed = LEVEL_FIELDS[level]
  const filtered: Record<string, unknown> = {}

  for (const [key, val] of Object.entries(evidence)) {
    if (!(KNOWN_FIELDS as readonly string[]).includes(key)) {
      if (onError) onError(new Error(`decision-evidence: dropped unknown field "${key}"`))
      continue
    }
    if (allowed.has(key)) filtered[key] = val
  }

  sanitiseConfidence(filtered, (err) => onError?.(err))

  if (Object.keys(filtered).length === 0) return null
  const result = filtered as DecisionEvidence
  const check = validateAgainstSchema(DECISION_EVIDENCE_SCHEMA, result)
  if (!check.valid && onError) {
    onError(new Error(`decision-evidence: schema violation - ${check.errors.join('; ')}`))
  }
  return result
}
