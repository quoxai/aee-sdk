/**
 * Sinks: where emitted envelopes go.
 *
 * A sink is any function `(envelope) => void | Promise<void>`. The capture
 * layer's `emit()` wraps sink invocation so it is fire-and-forget and NEVER
 * throws: failures are routed to the configured `onError` callback.
 *
 * Bundled sinks (all local, zero network):
 *   - stdout: one JSON line per envelope to process.stdout
 *   - file:   NDJSON append to a path, creating the parent directory
 *   - custom: any user-supplied function
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { AEEEnvelope } from '../envelope.js'

export type Sink = (envelope: AEEEnvelope) => void | Promise<void>

export type SinkName = 'stdout' | 'file' | 'custom'

export interface FileSinkOptions {
  /** Destination NDJSON file. Parent directories are created as needed. */
  path?: string
}

export interface StdoutSinkOptions {
  /** Optional writer override (defaults to process.stdout). */
  write?: (line: string) => void
}

/** Serialises an envelope to a single NDJSON line (trailing newline included). */
export function toNdjsonLine(envelope: AEEEnvelope): string {
  return JSON.stringify(envelope) + '\n'
}

/** Writes each envelope as one JSON line to stdout (or a supplied writer). */
export function createStdoutSink(options: StdoutSinkOptions = {}): Sink {
  const write = options.write || ((line: string) => process.stdout.write(line))
  return (envelope: AEEEnvelope) => {
    write(toNdjsonLine(envelope))
  }
}

const DEFAULT_FILE_PATH = './aee-envelopes.ndjson'

/** Appends each envelope as an NDJSON line, creating the parent dir if missing. */
export function createFileSink(options: FileSinkOptions = {}): Sink {
  const filePath = options.path || DEFAULT_FILE_PATH
  let dirEnsured = false

  return async (envelope: AEEEnvelope) => {
    if (!dirEnsured) {
      const dir = path.dirname(filePath)
      if (dir && dir !== '.') {
        await fs.mkdir(dir, { recursive: true })
      }
      dirEnsured = true
    }
    await fs.appendFile(filePath, toNdjsonLine(envelope), 'utf8')
  }
}

/** Wraps a user-supplied function as a sink (identity, for symmetry/typing). */
export function createCustomSink(fn: Sink): Sink {
  if (typeof fn !== 'function') {
    throw new Error('custom sink requires a function')
  }
  return fn
}
