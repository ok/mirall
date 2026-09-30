import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel) => readFileSync(path.join(root, rel), 'utf8')
const OVERLAY = 'src/shared/transfer/overlay'

// A JSDoc block binds to the declaration directly after it. One separated from its function by
// another comment or declaration documents nothing, and the editor attaches it to the wrong symbol.
const CASES = [
  { file: `${OVERLAY}/overlay-instance.js`, fn: 'attachOverlay', marker: 'Bind this swarm connection' },
  { file: `${OVERLAY}/overlay-authorize.js`, fn: 'makeServeAuthorizer', marker: '@param {object} deps' },
]

for (const { file, fn, marker } of CASES) {
  test(`the JSDoc for ${fn} sits directly above it`, (t) => {
    const src = read(file)
    const m = new RegExp(`/\\*\\*((?:(?!\\*/)[\\s\\S])*)\\*/\\nexport function ${fn}\\(`).exec(src)
    t.ok(m, `${fn} is immediately preceded by a JSDoc block`)
    t.ok(m?.[1].includes(marker), `and that block is the one documenting ${fn}`)
  })
}
