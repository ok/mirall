import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const workerFile = (...rel) => readFileSync(path.join(here, '..', '..', 'src', 'worker', ...rel), 'utf8')
const src = [workerFile('main.js'), workerFile('ipc', 'spaces.js')].join('\n')

// Every Space[] the worker ships must go through the ONE slimSpaces projection — a second,
// unprojected emit path (the original bug: the boot event:state shipped raw listSpaces
// records) leaks avatars/catalog keys and desyncs the renderer's SpaceMemberSummary contract
// (self-less member counts, missing pendingCount). Pinned structurally: the worker entry runs
// under Bare and cannot be imported by a test runner.
test('every Space[] payload the worker ships goes through slimSpaces', (t) => {
  t.ok(/ipc\.handle\('spaces:list', async \(\) => slimSpaces\(/.test(src),
    'spaces:list uses the shared projection')
  t.ok(/ipc\.emit\('event:state', \{ profile, spaces: await slimSpaces\(profile\) \}\)/.test(src),
    'the boot event:state uses the shared projection')
  t.absent(/ipc\.emit\('event:state'[^\n]*listSpaces/.test(src),
    'no raw listSpaces payload rides event:state')
})
