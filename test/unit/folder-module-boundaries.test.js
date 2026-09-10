import test from 'brittle'
import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (p) => readFileSync(path.resolve(here, '../../src', p), 'utf8')
import { pureFolderPolicyModules } from '../../eslint.config.mjs'

// The decomposition left these as re-exports so its own diff stayed on the move. Once the callers
// were re-pointed the shims went, and this keeps them gone: a re-export is the cheap way to undo a
// decomposition one import at a time, and nothing else fails when one grows back.
test('the folder engines no longer re-export what moved out of them', (t) => {
  const foreign = read('shared/folders/foreign-folders.js')
  t.absent(/export \{[^}]*\blocalRelOf\b/.test(foreign), 'localRelOf comes from mirror-state.js')
  t.absent(/export \{ previewMaterializeScan \}/.test(foreign), 'the preview comes from foreign-preview.js')
  t.absent(/export \{[^}]*\bshouldHonorDeletions\b/.test(foreign), 'the deletion gate comes from path-keys.js')

  const owned = read('shared/folders/owned-folders.js')
  t.absent(/export \{ previewInitialPublishScan \}/.test(owned), 'the preview comes from owned-preview.js')
})

// The four re-exports that predated the decomposition went the same way once their consumers
// were re-pointed; matching the export STATEMENT so the import of the same names from
// path-keys.js cannot satisfy it.
test('owned-folders.js re-exports nothing it does not own', (t) => {
  const owned = read('shared/folders/owned-folders.js')
  for (const name of ['shouldIgnore', 'DEFAULT_IGNORE', 'mountRootAvailable', 'walkDisk']) {
    t.absent(new RegExp(`export \\{[^}]*\\b${name}\\b[^}]*\\}`).test(owned), `${name} is imported from its owner, not re-exported`)
  }
})

// eslint.config.mjs is the one statement that these modules are pure; the half the linter cannot see
// is that something actually loads them under Node. A listed module with no unit importer is a
// purity claim nobody exercises.
test('every pure folder-policy module is driven by a unit test', (t) => {
  const suite = readdirSync(here)
    .filter((f) => f.endsWith('.test.js') && f !== 'folder-module-boundaries.test.js')
    .map((f) => readFileSync(path.join(here, f), 'utf8'))
    .join('\n')
  for (const name of pureFolderPolicyModules) {
    t.ok(suite.includes(`shared/folders/${name}.js`), `${name}.js is imported by a unit test`)
  }
})
