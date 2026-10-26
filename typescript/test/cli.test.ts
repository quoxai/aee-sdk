import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Child-process tests for the `aee-validate` CLI against the shared conformance
 * corpus: the valid dir passes (exit 0), the invalid dir fails (exit 1) with a
 * per-envelope reason, and unreadable input exits 2.
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.resolve(here, '..')
const binPath = path.join(pkgDir, 'dist', 'cjs', 'bin', 'aee-validate.js')
const fixturesDir = path.resolve(pkgDir, '..', 'conformance', 'fixtures')

interface CliResult {
  status: number
  stdout: string
  stderr: string
}

function runCli(args: string[], input?: string): CliResult {
  try {
    const stdout = execFileSync('node', [binPath, ...args], {
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string }
    return {
      status: err.status ?? 1,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    }
  }
}

/** Builds an NDJSON corpus of the `.envelope` from every fixture in a subdir. */
function ndjsonFromFixtures(subdir: string): { text: string; count: number } {
  const dir = path.join(fixturesDir, subdir)
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  const lines = files.map((f) => {
    const fx = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as { envelope: unknown }
    return JSON.stringify(fx.envelope)
  })
  return { text: lines.join('\n') + '\n', count: lines.length }
}

describe('aee-validate CLI', () => {
  let tmp: string

  beforeAll(() => {
    if (!existsSync(binPath)) {
      execFileSync('npm', ['run', 'build'], { cwd: pkgDir, stdio: 'ignore' })
    }
    tmp = mkdtempSync(path.join(os.tmpdir(), 'aee-cli-'))
  }, 120_000)

  it('exits 0 and reports all valid for the valid fixture corpus', () => {
    const { text, count } = ndjsonFromFixtures('valid')
    const file = path.join(tmp, 'valid.ndjson')
    writeFileSync(file, text)
    const res = runCli([file])
    expect(res.status).toBe(0)
    expect(res.stdout).toContain(`summary: ${count}/${count} valid`)
    expect(res.stdout).not.toContain('INVALID')
  })

  it('exits 1 and reports per-envelope reasons for the invalid fixture corpus', () => {
    const { text, count } = ndjsonFromFixtures('invalid')
    const file = path.join(tmp, 'invalid.ndjson')
    writeFileSync(file, text)
    const res = runCli([file])
    expect(res.status).toBe(1)
    expect(res.stdout).toContain(`summary: 0/${count} valid`)
    // Every line is flagged INVALID with a reason after it.
    expect(res.stdout).toMatch(/1: INVALID {2}\S/)
  })

  it('reads a single envelope from stdin (exit 0)', () => {
    const fx = JSON.parse(
      readFileSync(path.join(fixturesDir, 'valid', '01-spec-section-4.1-task.json'), 'utf8'),
    ) as { envelope: unknown }
    const res = runCli([], JSON.stringify(fx.envelope))
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('1: VALID')
  })

  it('accepts a JSON array of envelopes', () => {
    const valid = JSON.parse(
      readFileSync(path.join(fixturesDir, 'valid', '01-spec-section-4.1-task.json'), 'utf8'),
    ) as { envelope: unknown }
    const invalid = JSON.parse(
      readFileSync(path.join(fixturesDir, 'invalid', '14-result-reply_to-null.json'), 'utf8'),
    ) as { envelope: unknown }
    const res = runCli([], JSON.stringify([valid.envelope, invalid.envelope]))
    expect(res.status).toBe(1)
    expect(res.stdout).toContain('1: VALID')
    expect(res.stdout).toMatch(/2: INVALID/)
    expect(res.stdout).toContain('summary: 1/2 valid')
  })

  it('exits 2 when the input file is unreadable', () => {
    const res = runCli([path.join(tmp, 'does-not-exist.json')])
    expect(res.status).toBe(2)
    expect(res.stderr).toMatch(/cannot read file/)
  })

  it('exits 2 when the input is not valid JSON or NDJSON', () => {
    const res = runCli([], 'this is { not json')
    expect(res.status).toBe(2)
    expect(res.stderr).toMatch(/not valid JSON/)
  })
})
