// The folder screen used to run on a snapshot of the row that was clicked, and the router patched
// corrections back into it by hand as they happened — a rename spread in here, a mount reset there.
// A patch list is only ever as complete as the last field someone remembered, and the unmount reset
// had already drifted: it reset three of the four role fields and left mirrorStatus stale.
import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'renderer')
const read = (rel) => readFileSync(path.join(root, rel), 'utf8')

test('navigation holds a share id, never a share', (t) => {
  const nav = read('hooks/useAppNavigation.ts')
  t.ok(/selectedShareId: string \| null/.test(nav), 'the id is what navigation remembers')
  t.absent(/selectedShare\b(?!Id)/.test(nav), 'no share object is held across screens')
})

test('the folder screen is handed a share resolved from the listing', (t) => {
  const router = read('ScreenRouter.tsx')
  t.ok(/useShares\(/.test(router), 'the router reads the live listing')
  t.ok(/shares\.find\(\(s\) => s\.id === shareId\)/.test(router), 'and resolves the id against it')
  // The two patch callbacks are gone from both ends.
  t.absent(/onRenamed/.test(router), 'no rename is patched into a held share')
  t.absent(/onUnmounted/.test(router), 'no unmount reset is patched into a held share')
  t.absent(/onRenamed|onUnmounted/.test(read('screens/FolderView.tsx')),
    'and the folder screen no longer reports either upward')
})
