/**
 * ULID Generator
 * Universally Unique Lexicographically Sortable Identifier.
 *
 * Ported verbatim (behaviour-preserving) from quox-dashboard's
 * `src/lib/aee/ulid.js`. Zero dependencies. 26-character Crockford Base32,
 * monotonic within the same millisecond.
 *
 * Format: TTTTTTTTTTRRRRRRRRRRRRRRRR
 * - T = timestamp (10 chars, 48 bits, ms since Unix epoch)
 * - R = randomness (16 chars, 80 bits)
 */

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ENCODING_LENGTH = 32
const ULID_LENGTH = 26
const TIME_LENGTH = 10
const RANDOM_LENGTH = 16

// Maximum timestamp (10889-08-02T05:31:50.655Z)
const MAX_TIME = Math.pow(2, 48) - 1

// Track last timestamp and random values for monotonicity within a ms.
let lastTime = 0
let lastRandom: number[] = new Array(RANDOM_LENGTH).fill(0)

function encodeTime(timestamp: number): string {
  if (timestamp > MAX_TIME) {
    throw new Error('ULID timestamp overflow')
  }

  let str = ''
  for (let i = TIME_LENGTH - 1; i >= 0; i--) {
    const mod = timestamp % ENCODING_LENGTH
    str = CROCKFORD_BASE32[mod] + str
    timestamp = Math.floor(timestamp / ENCODING_LENGTH)
  }
  return str
}

/**
 * Generates the random component using a cryptographically secure source.
 * Does NOT fall back to Math.random(). Works in Node (globalThis.crypto,
 * available since Node 18) and browsers.
 */
function generateRandomness(): number[] {
  const random = new Array<number>(RANDOM_LENGTH)

  const cryptoObj = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } })
    .crypto
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const bytes = new Uint8Array(RANDOM_LENGTH)
    cryptoObj.getRandomValues(bytes)
    for (let i = 0; i < RANDOM_LENGTH; i++) {
      random[i] = bytes[i] % ENCODING_LENGTH
    }
  } else {
    // Do not fall back to Math.random(): it is not cryptographically secure.
    throw new Error('crypto.getRandomValues is required for secure ULID generation')
  }

  return random
}

function encodeRandom(random: number[]): string {
  return random.map((v) => CROCKFORD_BASE32[v]).join('')
}

/** Increments the random component for within-ms monotonicity. */
function incrementRandom(random: number[]): number[] {
  const newRandom = [...random]
  for (let i = RANDOM_LENGTH - 1; i >= 0; i--) {
    if (newRandom[i] < ENCODING_LENGTH - 1) {
      newRandom[i]++
      return newRandom
    }
    newRandom[i] = 0
  }
  throw new Error('ULID random overflow (too many IDs in same millisecond)')
}

/**
 * Generates a new ULID.
 *
 * @param timestamp Optional timestamp (defaults to Date.now()).
 * @returns 26-character ULID string.
 */
export function ulid(timestamp: number = Date.now()): string {
  // Ensure monotonicity within the same millisecond (and non-decreasing time).
  // An explicit timestamp at or below lastTime (e.g. a clock skew or an
  // out-of-order backfill) is CLAMPED up to lastTime and the random component
  // is incremented, so output never sorts backwards relative to a prior id.
  if (timestamp <= lastTime) {
    lastRandom = incrementRandom(lastRandom)
    timestamp = lastTime
  } else {
    lastTime = timestamp
    lastRandom = generateRandomness()
  }

  return encodeTime(timestamp) + encodeRandom(lastRandom)
}

/** Extracts the Unix millisecond timestamp encoded in a ULID. */
export function ulidTime(id: string): number {
  if (typeof id !== 'string' || id.length !== ULID_LENGTH) {
    throw new Error('Invalid ULID format')
  }

  const timeChars = id.slice(0, TIME_LENGTH).toUpperCase()
  let timestamp = 0

  for (const char of timeChars) {
    const index = CROCKFORD_BASE32.indexOf(char)
    if (index === -1) {
      throw new Error(`Invalid character in ULID: ${char}`)
    }
    timestamp = timestamp * ENCODING_LENGTH + index
  }

  return timestamp
}

/** Validates a ULID format (26 chars, Crockford Base32 alphabet). */
export function isValidUlid(id: unknown): boolean {
  if (typeof id !== 'string' || id.length !== ULID_LENGTH) {
    return false
  }

  const upper = id.toUpperCase()
  for (const char of upper) {
    if (!CROCKFORD_BASE32.includes(char)) {
      return false
    }
  }

  return true
}

/**
 * Generates a ULID with a category prefix, e.g. `prefixedUlid('CONV')`
 * -> `"CONV_01ARZ3NDEKTSV4RRFFQ69G5FAV"`.
 */
export function prefixedUlid(prefix: string): string {
  return `${prefix}_${ulid()}`
}

/** Compares two ULIDs for lexicographic sorting. */
export function compareUlid(a: string, b: string): number {
  return a.localeCompare(b)
}

export default ulid
