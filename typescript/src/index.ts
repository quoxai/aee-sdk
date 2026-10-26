/**
 * @quox/aee-sdk: framework-agnostic capture SDK for the AEE protocol.
 *
 * Layer 1: pure envelope functions (no I/O, no state).
 * Layer 2: capture (AEE.init / wrap / CaptureContext).
 */

// ULID
export {
  ulid,
  ulidTime,
  isValidUlid,
  prefixedUlid,
  compareUlid,
} from './ulid.js'

// Envelope factory + validation
export {
  PROTOCOL_VERSION,
  ENVELOPE_TYPES,
  PRIORITY_LEVELS,
  AEE_V1_SCHEMA,
  createEnvelope,
  createTask,
  createResult,
  createEvent,
  createError,
  validate,
  isAEEEnvelope,
} from './envelope.js'
export type {
  AEEEnvelope,
  EnvelopeType,
  Priority,
  TraceContext,
  CreateEnvelopeParams,
  EnvelopeOptions,
  ErrorDetails,
} from './envelope.js'

// Schema validation primitive
export { validateAgainstSchema } from './schema.js'
export type { JsonSchema, ValidationResult } from './schema.js'

// Decision evidence
export {
  DecisionEvidenceBuilder,
  filterEvidence,
  DECISION_EVIDENCE_SCHEMA,
} from './evidence.js'
export type {
  EvidenceLevel,
  DecisionEvidence,
  EvidenceErrorHandler,
} from './evidence.js'

// Sinks
export {
  createStdoutSink,
  createFileSink,
  createCustomSink,
  toNdjsonLine,
} from './sinks/index.js'
export type {
  Sink,
  SinkName,
  FileSinkOptions,
  StdoutSinkOptions,
} from './sinks/index.js'

// Capture layer
export { AEE, CaptureContext } from './capture.js'
export type {
  AEEConfig,
  SinkConfig,
  WrapSpec,
  RecordOptions,
  Session,
} from './capture.js'
