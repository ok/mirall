import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (p) => readFileSync(path.resolve(here, '../../src', p), 'utf8')

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

// The four that predate the decomposition and are deliberately NOT swept, asserted so the test
// above reads as a decision rather than an oversight. Matching the export STATEMENT matters: a
// bare substring check also matches owned-folders.js's import of the same names from path-keys.js,
// and would stay green with the re-export deleted.
test('the pre-existing owned-folders re-exports are left in place on purpose', (t) => {
  const owned = read('shared/folders/owned-folders.js')
  for (const name of ['shouldIgnore', 'DEFAULT_IGNORE', 'mountRootAvailable']) {
    t.ok(new RegExp(`export \\{[^}]*\\b${name}\\b[^}]*\\}(?!\\s*from)`).test(owned),
      `${name} still re-exported — it predates this work and has worker consumers`)
  }
  t.ok(/export \{ walkDisk \}/.test(owned), 'walkDisk still re-exported')
})
