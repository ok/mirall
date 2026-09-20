import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const RENDERER = path.resolve(here, '../../src/renderer')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

// A response cast is a claim about the wire made at the call site, with nothing relating it to the
// request name. There were 21; the contract now makes the same claim once, keyed by the name. The
// ceiling is zero, and the one exemption is spelled out rather than pattern-matched.
//
// `request(type, …)` where type is a variable, in the dev console, is a genuine cast of untyped
// input a human typed — that is the boundary, not a shortcut around the contract.
const EXEMPT = new Set(['platform/dev-console.ts'])

test('no renderer call site casts a response', (t) => {
  const offenders = []
  for (const file of walk(RENDERER)) {
    const rel = path.relative(RENDERER, file)
    if (EXEMPT.has(rel)) continue
    const src = readFileSync(file, 'utf8')
    for (const [line] of src.matchAll(/^.*\brequest\([^\n]*\bas\s+[A-Z][^\n]*$/gm)) {
      offenders.push(`${rel}: ${line.trim()}`)
    }
    for (const [line] of src.matchAll(/^.*\bas Promise<[^\n]*$/gm)) {
      offenders.push(`${rel}: ${line.trim()}`)
    }
  }
  t.alike(offenders, [], 'the contract declares the response — a cast here is a second, unrelated claim')
})

test('no hook re-declares a shape the contract owns', (t) => {
  const offenders = []
  for (const file of walk(path.join(RENDERER, 'hooks'))) {
    const src = readFileSync(file, 'utf8')
    // The duplicated pair the issue names: two independent DownloadFileResult declarations for two
    // different requests, neither related to the row it described.
    if (/interface DownloadFileResult\b/.test(src)) offenders.push(path.relative(RENDERER, file))
    if (/interface ListResult\b/.test(src)) offenders.push(path.relative(RENDERER, file))
  }
  t.alike(offenders, [], 'a local mirror of a response shape')
})
