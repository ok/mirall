import test from 'brittle'
import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

// files:list answers a listing envelope. A flow test that names the request reads the envelope
// where it means the rows, and a predicate like `!Array.isArray(x) || …` then passes on any answer;
// test/helpers/peer.js's files/untilFiles hand over the rows and throw on any other shape.
const testRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REQUEST = /['"`]files:list['"`]/

test('flow tests read files:list only through peer.files / peer.untilFiles', (t) => {
  const flowDir = path.join(testRoot, 'flow')
  const offenders = readdirSync(flowDir)
    .filter((name) => name.endsWith('.js'))
    .filter((name) => REQUEST.test(readFileSync(path.join(flowDir, name), 'utf8')))
  t.alike(offenders, [], 'no flow test names files:list')
})

test('the helpers are where files:list is requested', (t) => {
  t.ok(REQUEST.test(readFileSync(path.join(testRoot, 'helpers', 'peer.js'), 'utf8')), 'peer.js requests files:list')
})
