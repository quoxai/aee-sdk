/**
 * Post-build fixup for the dual ESM/CJS output.
 *
 * The root package.json is `"type": "module"`, so every `.js` under dist would
 * be treated as ESM by Node. We drop a per-directory package.json marker so the
 * CJS output is loaded as CommonJS and the ESM output stays module, letting the
 * exports map serve both `require()` and `import` from one published package.
 * Zero dependencies: plain node:fs.
 */
import { writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const dist = path.resolve(here, '..', 'dist')

const targets = [
  { dir: path.join(dist, 'cjs'), json: { type: 'commonjs' } },
  { dir: path.join(dist, 'esm'), json: { type: 'module' } },
]

for (const { dir, json } of targets) {
  if (!existsSync(dir)) {
    throw new Error(`fixup-dual-build: expected build output at ${dir} (did the tsc step run?)`)
  }
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(json, null, 2) + '\n')
}

console.log('dual-build fixup: wrote dist/cjs/package.json and dist/esm/package.json')
