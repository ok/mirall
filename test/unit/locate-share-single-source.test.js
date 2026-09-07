import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const RENDERER = path.resolve(here, '../../src/renderer')
const OWNER = 'hooks/useLocateShare.ts'

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

// Relocating an owned folder is offered from five surfaces and says a sentence that names the share.
// Two screens had written that pair out; a third would have said it differently.
test('only useLocateShare issues owned-folder:relocate', (t) => {
  for (const f of files) {
    if (f.rel === OWNER) continue
    t.absent(f.src.includes("'owned-folder:relocate'"), `${f.rel}: go through useLocateShare`)
  }
  t.ok(read(OWNER).includes("'owned-folder:relocate'"), 'and it is where the channel actually lives')
  t.ok(read(OWNER).includes("t('share.locateSuccess'"), 'along with the sentence it says on success')
})

// Collapsing the two halves into one is the mistake this names: Edit Folder renders the failure in
// its own field error, so `relocate` has to reach it.
test('relocate propagates; only the browse-then-relocate path toasts', (t) => {
  const src = read(OWNER)
  const relocate = src.slice(src.indexOf('const relocate'), src.indexOf('const locate'))
  t.absent(/catch/.test(relocate), 'relocate has no catch of its own')
  t.ok(/toast\.error/.test(src.slice(src.indexOf('const locate'))), 'locate does')
})

// The foreign half is a different channel and a different sentence, and it is deliberately not
// shared — one folder screen issues it, from the branch the owner half returns before.
test('the mirror relocate stays where it is', (t) => {
  const screens = files.filter((f) => f.src.includes("'foreign-folder:relocate'")).map((f) => f.rel)
  t.alike(screens, ['screens/FolderView.tsx'])
})
