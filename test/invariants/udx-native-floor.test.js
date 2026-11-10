import test from 'brittle'
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// Every peer connection rides on udx-native. From 1.22.0 it bundles a libudx that raises its packet
// size past the 1200-byte base and recovers a lost retransmission without waiting out its one-second
// minimum RTO; below that, a lossy Wi-Fi path stalls a transfer for whole seconds at a time.
// udx-native reaches us only through hyperdht's range, so the lockfile alone decides what ships.
const FLOOR = [1, 22, 0]

const atLeast = (version, floor) => {
  const parts = version.split('-')[0].split('.').map(Number)
  for (let i = 0; i < floor.length; i++) {
    if (parts[i] !== floor[i]) return parts[i] > floor[i]
  }
  return true
}

const locked = Object.entries(JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')).packages)
  .filter(([location]) => location.endsWith('node_modules/udx-native'))

test('REGRESSION (FIX-740: transfers stalled for seconds at a time on a lossy Wi-Fi path): the lockfile resolves udx-native at or above 1.22.0', (t) => {
  t.ok(locked.length > 0, 'the lockfile resolves udx-native')
  const below = locked.filter(([, entry]) => !atLeast(entry.version, FLOOR)).map(([location, entry]) => `${location}@${entry.version}`)
  t.alike(below, [], `every udx-native in the lockfile is at least ${FLOOR.join('.')}`)
})
