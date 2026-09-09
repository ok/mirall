import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const RENDERER = path.resolve(here, '../../src/renderer')
const OWNER = 'components/layout/ModalHeader.tsx'

function tsxFiles (dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) tsxFiles(p, out)
    else if (name.endsWith('.tsx')) out.push(p)
  }
  return out
}

const files = tsxFiles(RENDERER).map((f) => ({
  rel: path.relative(RENDERER, f).split(path.sep).join('/'),
  src: readFileSync(f, 'utf8'),
}))
const read = (rel) => files.find((f) => f.rel === rel).src

// Seventeen dialogs wrote out the same header block. Two had drifted off the padding design.md
// documents, one titled itself with an <h2>, and twelve were missing the gap that keeps a long title
// off the close button. The checks below are STRUCTURAL — the header row and its container —
// deliberately not the title's class string: two legitimate non-headers reuse that type
// (FilenameTitle, and the centred "sent" panel in FeedbackModal), and the seventeenth dialog wrote
// the same six utilities in a different order, so a string match both over- and under-reports.
test('only ModalHeader declares the dialog header block', (t) => {
  const HEADER_ROW = 'flex justify-between items-start'
  const CONTAINER = 'px-10 pt-10'
  // Two <Modal> consumers that legitimately have no header row: the cheatsheet's close button is
  // absolutely positioned in the corner and its title sits in its own block, and the command palette
  // opens straight into its search field with no title at all.
  const NO_HEADER = new Set(['keyboard/ShortcutsHint.tsx', 'keyboard/CommandPalette.tsx'])

  for (const f of files) {
    if (f.rel === OWNER) continue
    t.absent(f.src.includes(HEADER_ROW), `${f.rel}: the title/close row belongs to ModalHeader`)
    if (!NO_HEADER.has(f.rel)) {
      t.absent(f.src.includes(CONTAINER), `${f.rel}: the header container belongs to ModalHeader`)
    }
  }
})

// Every dialog, including the one that does not live in the dialog folder. ActivityLogSettings mounts
// its purge confirm inline, which is how it stayed out of sight long enough to diverge twice — so it
// is named here rather than found by a folder walk.
//
// The two mount wizards reach the header through MountWizardStep, which is a dialog SHELL rather
// than a dialog; the assertion below it closes that indirection so the hop cannot become a hole.
const SHELL = 'components/modals/MountWizardStep.tsx'

test('every dialog gets its header from the owner', (t) => {
  const dialogs = files.filter((f) => f.rel.startsWith('components/modals/')).map((f) => f.rel)
  t.ok(dialogs.length >= 16, `found ${dialogs.length} dialogs under components/modals`)
  for (const rel of [...dialogs, 'screens/ActivityLogSettings.tsx']) {
    const src = read(rel)
    t.ok(src.includes('<ModalHeader') || src.includes('<MountWizardStep'),
      `${rel} takes its header from ModalHeader`)
  }
  t.ok(read(SHELL).includes('<ModalHeader'), 'and the wizard shell takes its own from there too')
})

// The title comes from ModalHeader or from FilenameTitle, which renders its own. A dialog that
// declares one itself is a dialog that picked its own heading level, which is how the seventeenth
// ended up an <h2> while sixteen others used <h1>.
test('no dialog declares its own heading', (t) => {
  for (const f of files) {
    if (!f.rel.startsWith('components/modals/')) continue
    t.absent(/<h1/.test(f.src), `${f.rel}: the title is ModalHeader's or FilenameTitle's`)
  }
})

test('the header row keeps its floor between title and close', (t) => {
  const owner = read(OWNER)
  t.ok(/flex justify-between items-start mb-2 gap-3/.test(owner), 'title and close can never touch')
  t.ok(/px-10 pt-10 pb-6/.test(owner), 'and the container is the padding design.md documents')
})
