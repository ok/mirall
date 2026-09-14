import { spawn } from 'node:child_process'
import path from 'node:path'
import { CASES } from './cases.mjs'

// `npm run test:layout:case -- members` replaces the eighteen test:layout:* scripts. Each case still
// owns its own run-*.mjs, because the per-case reporting is the one genuinely bespoke part.
const [name, ...rest] = process.argv.slice(2)
if (!name || !CASES.some((c) => c.name === name)) {
  console.error(`usage: npm run test:layout:case -- <case> [--no-build]\ncases: ${CASES.map((c) => c.name).join(', ')}`)
  process.exit(2)
}

const runner = path.join(import.meta.dirname, name === 'harness' ? 'run.mjs' : `run-${name}.mjs`)
spawn(process.execPath, [runner, ...rest], { stdio: 'inherit' }).on('exit', (code) => process.exit(code ?? 1))
