import test from 'brittle'
import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dir = path.join(root, 'test', 'typecheck')
const workerDir = path.join(dir, 'worker')

const readJson = (file) => JSON.parse(readFileSync(path.join(root, file), 'utf8'))

function assertRejections(t, folder) {
  const files = readdirSync(folder).filter((f) => f.endsWith('.ts'))
  t.ok(files.length >= 1, `${path.relative(root, folder)} holds at least one assertion file`)
  for (const file of files) {
    const src = readFileSync(path.join(folder, file), 'utf8')
    const directives = src.match(/^\/\/ @ts-expect-error /gm) ?? []
    t.ok(directives.length >= 8, `${file} asserts at least eight rejections (${directives.length})`)
  }
}

// The compile-time assertions are the successor of the sidecar drift guard: a contract union that
// widens to `string` turns their @ts-expect-error directives into TS2578 errors. They only guard
// while tsc reads them, and tsc reads only what tsconfig includes.
test('the typecheck assertions are part of the tsc program', (t) => {
  const tsconfig = readJson('tsconfig.json')
  t.ok(tsconfig.include.includes('test/typecheck'), 'tsconfig includes test/typecheck')
  t.is(tsconfig.compilerOptions.checkJs, true, 'checkJs is on, so the JS modules the assertions import are checked too')
  assertRejections(t, dir)
})

// The handler assertions import the worker's router, so they belong to the worker program and must
// stay out of the renderer's: there they would pull the whole data layer in under checkJs.
test('the handler assertions are part of the worker program, and only that one', (t) => {
  const tsconfig = readJson('tsconfig.json')
  const worker = readJson('tsconfig.worker.json')
  t.ok(tsconfig.exclude?.includes('test/typecheck/worker'), 'the renderer program excludes them')
  t.ok(worker.include.includes('test/typecheck/worker'), 'the worker program includes them')
  t.ok(worker.include.includes('src/worker'), 'alongside the handler modules they hold to the contract')
  t.is(worker.compilerOptions.strict, true, 'under strict')
  t.is(worker.compilerOptions.checkJs, false, 'checking only the files that opt in, not the data layer they import')
  t.ok(/tsc -p tsconfig\.worker\.json/.test(readJson('package.json').scripts.typecheck), 'and npm run typecheck compiles it')
  assertRejections(t, workerDir)
})
