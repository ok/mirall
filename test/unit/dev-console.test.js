import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { transformSync } from 'esbuild'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// TypeScript the Node runner cannot import directly. Its one runtime import (the IPC client) is
// stubbed through `require`, and `window` / `console` are injected so the module installs itself
// onto a fake window and its output is observable.
function loadConsole() {
  const src = readFileSync(path.join(root, 'src/renderer/platform/dev-console.ts'), 'utf8')
  const { code } = transformSync(src, { loader: 'ts', format: 'cjs' })
  const printed = []
  const sink = (...args) => printed.push(args)
  const fakeConsole = { log: sink, table: sink, warn: sink, error: sink }
  const window = { bridge: {} }
  const require = () => ({ request: async () => ({}) })
  new Function('require', 'module', 'exports', 'window', 'console', code)(require, { exports: {} }, {}, window, fakeConsole)
  return { mirall: window.mirall, printed }
}

test('dev-console: help() returns the command list it prints', (t) => {
  const { mirall, printed } = loadConsole()
  printed.length = 0
  const commands = mirall.help()
  t.ok(commands && typeof commands === 'object', 'a filtered console still shows the list as the return value')
  t.is(commands['help()'], 'Show this list.')
  t.ok(printed.some((args) => args[0] === commands), 'the returned map is the one handed to console.table')
})

test('dev-console: every command on window.mirall has a help() row', (t) => {
  const { mirall } = loadConsole()
  const listed = new Set(Object.keys(mirall.help()).map((signature) => signature.slice(0, signature.indexOf('('))))
  for (const name of Object.keys(mirall)) t.ok(listed.has(name), `${name} is listed`)
  t.is(listed.size, Object.keys(mirall).length, 'and help() lists nothing that does not exist')
})
