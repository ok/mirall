import test from 'brittle'
import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dir = path.join(root, 'test', 'typecheck')

// The compile-time assertions are the successor of the sidecar drift guard: a contract union that
// widens to `string` turns their @ts-expect-error directives into TS2578 errors. They only guard
// while tsc reads them, and tsc reads only what tsconfig includes.
test('the typecheck assertions are part of the tsc program', (t) => {
  const tsconfig = JSON.parse(readFileSync(path.join(root, 'tsconfig.json'), 'utf8'))
  t.ok(tsconfig.include.includes('test/typecheck'), 'tsconfig includes test/typecheck')
  t.is(tsconfig.compilerOptions.checkJs, true, 'checkJs is on, so the JS modules the assertions import are checked too')
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'))
  t.ok(files.length >= 1, 'at least one assertion file exists')
  for (const file of files) {
    const src = readFileSync(path.join(dir, file), 'utf8')
    const directives = src.match(/^\/\/ @ts-expect-error /gm) ?? []
    t.ok(directives.length >= 8, `${file} asserts at least eight rejections (${directives.length})`)
  }
})
