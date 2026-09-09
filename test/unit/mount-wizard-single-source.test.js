import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const RENDERER = path.resolve(here, '../../src/renderer')

function sourceFiles (dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) sourceFiles(p, out)
    else if (name.endsWith('.ts') || name.endsWith('.tsx')) out.push(p)
  }
  return out
}

const files = sourceFiles(RENDERER).map((f) => ({
  rel: path.relative(RENDERER, f).split(path.sep).join('/'),
  src: readFileSync(f, 'utf8'),
}))
const read = (rel) => files.find((f) => f.rel === rel).src

const WIZARDS = ['components/modals/AddFolderShareModal.tsx', 'components/modals/MirrorFolderModal.tsx']

// The owned and foreign mount wizards are one state machine over three injected calls — validate a
// path, scan it, commit it. Each had a copy: the same step and submitting state, the same
// reset-on-open effect, the same point-in-time validation probe, the same rule that a cancelled scan
// returns you to the edit step. Nothing enforced that the two copies stayed one answer.
test('neither mount wizard runs its own step machine', (t) => {
  for (const rel of WIZARDS) {
    const src = read(rel)
    t.ok(src.includes('useMountWizard('), `${rel} uses the shared machine`)
    t.absent(/useState<Step>|type Step =/.test(src), `${rel} keeps no step state of its own`)
    t.absent(/PREVIEW_CANCELLED/.test(src), `${rel} does not re-decide what a cancelled scan means`)
    t.absent(/browseShareFolder\(\)/.test(src), `${rel} does not open the picker itself`)
    t.absent(/validationError, set/.test(src), `${rel} does not hold its own validation verdict`)
  }
})

test('the wizard shell and its path field have one implementation each', (t) => {
  for (const rel of WIZARDS) {
    const src = read(rel)
    t.ok(src.includes('<MountWizardStep'), `${rel} renders the shared edit step`)
    t.ok(src.includes('<MountPathField'), `${rel} renders the shared path field`)
    t.absent(src.includes('<PathRow'), `${rel} reaches PathRow through MountPathField`)
  }
})

test('usePreviewFlow has one consumer', (t) => {
  const consumers = files.filter((f) => f.src.includes('usePreviewFlow')).map((f) => f.rel).sort()
  t.alike(consumers, ['hooks/useMountWizard.ts', 'hooks/usePreviewFlow.ts'])
})

// The injected calls are inline arrows built from props, so their identity changes every render. A
// validate() reaching the validation effect's dependency list would clear the verdict, re-render and
// spin — which is why the hook holds them in a ref.
test('the injected calls stay out of the effect dependency lists', (t) => {
  const src = read('hooks/useMountWizard.ts')
  t.ok(src.includes('opsRef.current.validate('), 'validate is called through the ref')
  t.ok(src.includes('opsRef.current.startPreview('), 'so is startPreview')
  t.ok(src.includes('opsRef.current.commit('), 'and commit')
  for (const deps of src.match(/\}, \[[^\]]*\]\)/g) ?? []) {
    for (const op of ['validate', 'startPreview', 'commit', 'onCommitted']) {
      t.absent(new RegExp(`\\b${op}\\b`).test(deps), `${op} is not a dependency (${deps.trim()})`)
    }
  }
})
