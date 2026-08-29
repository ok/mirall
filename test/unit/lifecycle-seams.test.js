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

// REGRESSION (LIFECYCLE-2d: each of these existed so a module that could not be closed could be
// reused in one process. Their replacements are resources whose construction does what the reset
// did, so a reappearance means a lifetime went unowned again.)
const RETIRED = [
  '_resetOwnedFolders',
  '_resetPublishService',
  '_resetServeLedger',
  'armPublishService',
  'closePublishService',
  'stopAllPublishing',
  'initServeLedger',
]

test('REGRESSION (LIFECYCLE-2d): the storage-layer reset seams are gone from src/', (t) => {
  const files = roots.flatMap((r) => walk(r))
  for (const file of files) {
    const src = readFileSync(file, 'utf8')
    for (const name of RETIRED) {
      t.absent(src.includes(name), path.relative(process.cwd(), file) + ' references ' + name)
    }
  }
  const scheduler = readFileSync(path.join(here, '..', '..', 'src', 'shared', 'folders', 'publish-scheduler.js'), 'utf8')
  t.absent(scheduler.includes('_reset('), 'the scheduler has no reset — instances are constructed per boot')
})
