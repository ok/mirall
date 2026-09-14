import test from 'brittle'
import { existsSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const COMPONENTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/renderer/components')

// widgets/ was nine domains in one folder, and the refactor before this one added nine more files to
// it while a plan to empty it was open. It is gone; a component now names the feature it serves.
test('components/widgets does not come back', (t) => {
  t.absent(existsSync(path.join(COMPONENTS, 'widgets')), 'widgets/ is not a destination')
})

// A list rather than a count: adding a folder is a decision, and taking a row here is how it gets
// made deliberately instead of by whoever had nowhere else to put a file.
const FOLDERS = ['activity', 'cards', 'folder', 'layout', 'modals', 'path', 'primitives', 'share-drop', 'space', 'toast']

test('every components/ child is a named feature', (t) => {
  const actual = readdirSync(COMPONENTS)
    .filter((name) => statSync(path.join(COMPONENTS, name)).isDirectory())
    .sort()
  t.alike(actual, [...FOLDERS].sort(), 'a new component folder takes a row here')
})
