import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
// The resume loop and the probe moved out of worker/main.js into the mount runtime the boot root
// starts (worker/mounts-runtime.js); the anchors below are unchanged, only their home is.
const workerSrc = readFileSync(path.join(here, '..', '..', 'src', 'worker', 'mounts-runtime.js'), 'utf8')

// The boot loop + probe branch aren't reachable without Electron; pin the wiring by source
// (mirrors test/unit/worker-epipe-guard.test.js) so a refactor can't silently drop it.

test('G2 wiring: the boot foreign-mount loop attempts auto-resume for disabled mounts', (t) => {
  const loop = workerSrc.match(/listForeignMounts\(\)[\s\S]*?foreign-folder restart failed/)?.[0] || ''
  t.ok(/resumeAutoPausedForeignMount/.test(loop), 'boot loop calls resumeAutoPausedForeignMount')
})

test('G2 wiring: the mount-point probe resumes a returned foreign mount', (t) => {
  const probe = workerSrc.match(/async probeMountPoints\([\s\S]*?\n  \}/)?.[0] || ''
  t.ok(/resumeAutoPausedForeignMount/.test(probe), 'probe foreign branch calls resumeAutoPausedForeignMount')
})

// F1: foreign mounts must be seeded into lastMountPointStatus at boot (parity with owned),
// or the probe's wasGone can never fire and a mount-point return is never detected.
test('G2 wiring: the boot foreign-mount loop seeds lastMountPointStatus', (t) => {
  const loop = workerSrc.match(/listForeignMounts\(\)[\s\S]*?foreign-folder restart failed/)?.[0] || ''
  t.ok(/lastMountPointStatus\.set\('foreign-folder:'/.test(loop), 'boot loop seeds the probe baseline for foreign mounts')
})
