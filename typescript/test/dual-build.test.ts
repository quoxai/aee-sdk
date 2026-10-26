import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Proves the published package is consumable from BOTH module systems: a
 * temp-dir `npm pack` + `file:` install loaded via `require()` AND `import`.
 * This is the regression guard for the CJS `ERR_PACKAGE_PATH_NOT_EXPORTED`
 * failure the dual build fixes.
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.resolve(here, '..')

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

describe('dual build: package loads via require() and import', () => {
  let tmp: string
  let consumer: string

  beforeAll(() => {
    // CI builds before testing; locally, build on demand so the tarball is real.
    if (!existsSync(path.join(pkgDir, 'dist', 'cjs', 'index.js'))) {
      run('npm', ['run', 'build'], pkgDir)
    }
    tmp = mkdtempSync(path.join(os.tmpdir(), 'aee-dualbuild-'))
    run('npm', ['pack', pkgDir, '--silent'], tmp)
    const tgz = readdirSync(tmp).find((f) => f.endsWith('.tgz'))
    if (!tgz) throw new Error('npm pack produced no tarball')

    consumer = path.join(tmp, 'consumer')
    mkdirSync(consumer, { recursive: true })
    run('npm', ['init', '-y'], consumer)
    // Install the packed tarball as a file: dependency (offline: zero deps).
    run('npm', ['install', path.join(tmp, tgz), '--no-audit', '--no-fund', '--offline'], consumer)
  }, 120_000)

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  })

  it('loads through require() (CommonJS consumer)', () => {
    const script =
      "const s=require('@quox/aee-sdk');" +
      "const t=s.createTask('a','b','ops.ping.check',{k:1});" +
      "if(!s.validate(t).valid) throw new Error('invalid');" +
      "if(typeof s.AEE!=='function') throw new Error('no AEE');" +
      "process.stdout.write('CJS_OK');"
    const out = run('node', ['-e', script], consumer)
    expect(out).toContain('CJS_OK')
  })

  it('loads through import (ESM consumer)', () => {
    const script =
      "import('@quox/aee-sdk').then(m=>{" +
      "const t=m.createTask('a','b','ops.ping.check',{k:1});" +
      "if(!m.validate(t).valid) throw new Error('invalid');" +
      "if(typeof m.AEE!=='function') throw new Error('no AEE');" +
      "process.stdout.write('ESM_OK');});"
    const out = run('node', ['--input-type=module', '-e', script], consumer)
    expect(out).toContain('ESM_OK')
  })
})
