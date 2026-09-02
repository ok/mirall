import test from 'brittle'
import { readdirSync, readFileSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// One filesystem path the user can act on has ONE presentation: `widgets/PathRow.tsx`. Five
// surfaces show one (Add Folder, Mirror to Disk, Edit Folder, Edit Space, Storage settings) and
// they had drifted into two shapes — three shared the filled field while two rendered a bare line
// of text beside a shorter, dimmer `secondary` button, so the same fact looked like a different
// kind of thing depending on which door you came through. Geometry and colour are not testable
// from here; what IS testable is the drift's mechanism, and each check below pins one step of it.
const here = path.dirname(fileURLToPath(import.meta.url))
const RENDERER = path.resolve(here, '../../src/renderer')
const read = (p) => readFileSync(p, 'utf8')

function tsxFiles (dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full))
    else if (entry.endsWith('.tsx')) out.push(full)
  }
  return out
}

const files = tsxFiles(RENDERER).map((f) => ({ rel: path.relative(RENDERER, f), src: read(f) }))
const pathRow = read(path.join(RENDERER, 'components/widgets/PathRow.tsx'))

// `FilePath` renders the path text alone. Beside an action it is the bare-text form this
// consolidation removed, so its every use is listed here with the reason it is not a path field.
// A new name in this list is the review question: should this be a PathRow?
const FILE_PATH_CALLERS = new Set([
  'components/widgets/PathRow.tsx',          // the path field itself
  'components/modals/ScanPreviewModal.tsx',  // rows of a file list, not a path the user re-picks
  'screens/StorageSettings.tsx',             // the app-storage location: display-only, with Copy
])

test('FilePath is rendered only where a path field would be wrong', (t) => {
  const callers = files.filter((f) => f.src.includes('<FilePath')).map((f) => f.rel)
  for (const rel of callers) {
    t.ok(FILE_PATH_CALLERS.has(rel), `${rel} renders <FilePath> — use <PathRow> unless listed`)
  }
})

test('every path the user can re-pick goes through PathRow', (t) => {
  // The two folder pickers main exposes. A screen that opens one and shows the result IS a path
  // field; the only callers that legitimately open one without showing a path are the action-menu
  // entries (Locate / relocate from a card), which navigate rather than render a row.
  const MENU_ONLY = new Set(['screens/SpaceView.tsx', 'screens/FolderView.tsx'])
  const pickers = files.filter((f) => /window\.bridge\.browse(DownloadFolder|ShareFolder)\(/.test(f.src))
  t.ok(pickers.length > 0, 'the picker calls were found at all')
  for (const f of pickers) {
    if (MENU_ONLY.has(f.rel)) continue
    t.ok(f.src.includes('<PathRow'), `${f.rel} picks a folder and must show it in a PathRow`)
  }
})

test('the path button label is derived, never passed', (t) => {
  // Four strings once said the one thing — "Browse…", "Change", "Change…", "Change folder" — one
  // per caller. PathRow now derives it from whether there is a path yet, so a caller that passes
  // its own is re-opening that drift.
  t.ok(/actionLabel \?\? \(path \? t\('actions\.change'\) : t\('pathField\.browse'\)\)/.test(pathRow),
    'PathRow derives the label from the presence of a path')
  for (const f of files) {
    if (f.rel === 'components/widgets/PathRow.tsx') continue
    t.absent(/<PathRow[^>]*actionLabel/s.test(f.src), `${f.rel} must not override the path button label`)
  }
})

test('a path field on a settings screen is filled a step below its card', (t) => {
  // The field's default fill IS the settings-card fill — the same token, so the same hex in both
  // themes — and a field filled with its own background is an invisible field. Modals are safe
  // (the panel is `surface-container-lowest`); a settings card is not, so a row inside one takes
  // `fill="lowest"`. This is the same relationship NetworkSettings' number input already has.
  const CARD_FILL = 'bg-surface-container-low'
  t.ok(pathRow.includes(`low: '${CARD_FILL}'`), "PathRow's default fill is the settings-card token")
  for (const f of files) {
    if (!f.rel.startsWith('screens/')) continue
    for (const m of f.src.matchAll(/<PathRow\b/g)) {
      const row = f.src.slice(m.index, f.src.indexOf('/>', m.index))
      t.ok(/fill="lowest"/.test(row),
        `${f.rel} renders a PathRow inside a settings card and must pass fill="lowest"`)
    }
  }
})
