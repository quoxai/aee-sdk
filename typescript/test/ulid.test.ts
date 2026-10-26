import { describe, it, expect } from 'vitest'
import { ulid, ulidTime, isValidUlid, prefixedUlid, compareUlid } from '../src/index.js'

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

describe('ulid', () => {
  it('produces a 26-char Crockford Base32 string', () => {
    const id = ulid()
    expect(id).toHaveLength(26)
    expect(ULID_RE.test(id)).toBe(true)
  })

  it('encodes the supplied timestamp recoverably', () => {
    // Use "now": a non-decreasing timestamp is never clamped, so it round-trips.
    const t = Date.now()
    const id = ulid(t)
    expect(ulidTime(id)).toBe(t)
  })

  it('is monotonic within the same millisecond (fixed timestamp)', () => {
    const t = 1700000000000
    const ids = Array.from({ length: 50 }, () => ulid(t))
    for (let i = 1; i < ids.length; i++) {
      expect(compareUlid(ids[i - 1], ids[i])).toBeLessThan(0)
    }
  })

  it('never produces duplicates in a tight loop', () => {
    const set = new Set<string>()
    for (let i = 0; i < 1000; i++) set.add(ulid())
    expect(set.size).toBe(1000)
  })

  it('is lexicographically increasing across advancing timestamps', () => {
    const a = ulid(1000)
    const b = ulid(2000)
    expect(a < b).toBe(true)
  })

  it('validates ULID format via isValidUlid', () => {
    expect(isValidUlid(ulid())).toBe(true)
    expect(isValidUlid('not-a-ulid')).toBe(false)
    expect(isValidUlid('01ARZ3NDEKTSV4RRFFQ69G5FAI')).toBe(false) // contains I
    expect(isValidUlid(12345 as unknown as string)).toBe(false)
  })

  it('prefixedUlid prepends the category and an underscore', () => {
    const id = prefixedUlid('CONV')
    expect(id.startsWith('CONV_')).toBe(true)
    expect(isValidUlid(id.slice(5))).toBe(true)
  })

  it('ulidTime rejects malformed input', () => {
    expect(() => ulidTime('short')).toThrow(/Invalid ULID/)
    // 'I' in the time portion (first 10 chars) is not a Crockford Base32 char.
    expect(() => ulidTime('0I000000000000000000000000')).toThrow(/Invalid character/)
  })

  it('does not sort backwards when an explicit past timestamp follows a future one', () => {
    // Drive lastTime forward with a future timestamp, then request an earlier
    // one. The earlier request must be CLAMPED up to lastTime so output stays
    // monotonic (the regression: it used to encode the smaller time and sort
    // before its predecessor).
    const base = Date.now() + 100_000
    const future = ulid(base + 1000)
    const past = ulid(base)
    expect(base).toBeLessThan(base + 1000)
    // Monotonic output: the later call sorts AFTER the earlier one.
    expect(compareUlid(future, past)).toBeLessThan(0)
    // The clamped timestamp is lifted to lastTime, never a time before `future`.
    expect(ulidTime(past)).toBe(ulidTime(future))
  })
})
