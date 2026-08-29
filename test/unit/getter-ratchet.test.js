import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const roots = ['shared', 'worker'].map((d) => path.join(here, '..', '..', 'src', d))

function walk (dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'vendor') walk(p, out) } else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

// Service-locator reads may fall but never rise: new code takes its collaborators as deps. These
// are the measured counts on this branch (definitions excluded), and Phase 3 lowers them as the
// swarm and overlay take their collaborators explicitly.
const CEILINGS = { 'getStore(': 20, 'getOverlay(': 19, 'getProfileBee(': 12, 'getContentSwarm(': 3 }

function countCalls (needle) {
  let n = 0
  for (const file of roots.flatMap((r) => walk(r))) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes(needle)) continue
      if (line.includes('export function ' + needle) || line.includes('export async function ' + needle)) continue
      n += line.split(needle).length - 1
    }
  }
  return n
}

test('service-locator call sites do not grow', (t) => {
  for (const [needle, ceiling] of Object.entries(CEILINGS)) {
    const n = countCalls(needle)
    t.ok(n <= ceiling, needle + ' ' + n + ' call site(s), ceiling ' + ceiling + ' — take it as a dep instead')
  }
})
