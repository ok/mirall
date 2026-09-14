import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'

const root = new URL('../../', import.meta.url)
const read = (p) => readFileSync(fileURLToPath(new URL(p, root)), 'utf8')

const ROW = 'src/renderer/components/cards/ShareFileRow.tsx'
const CARD = 'src/renderer/components/cards/FileCard.tsx'
const LANE = 'src/renderer/components/cards/RowLane.tsx'

// The two file-row kinds once decided their lane in two places, at two layers, with two precedence
// orders — and drifted into three user-visible divergences. These pin the single source down.
test('neither row component derives its own lane', (t) => {
  for (const p of [ROW, CARD]) {
    const src = read(p)
    t.ok(/deriveRowView\(/.test(src), `${p} uses the shared view-model`)
    t.absent(/showDownloadProgressBar|showIndexProgressBar|showPausedProgressBar/.test(src),
      `${p} has no hand-rolled lane gate`)
  }
})

test('REGRESSION (FIX-RV-1: every file-row badge carries an accessible name)', (t) => {
  // The accessible name landed on the share row's six badges and missed the loose row's, because
  // there were two implementations of one row. There is now one lane component; this asserts no
  // badge escapes it.
  const lane = read(LANE)
  const badges = lane.match(/<Badge\b/g) ?? []
  const labelled = lane.match(/srLabel=/g) ?? []
  t.ok(badges.length > 0, 'the lane renders badges')
  t.is(labelled.length, badges.length, 'every <Badge> in the lane is named')
  for (const p of [ROW, CARD]) t.absent(/<Badge\b/.test(read(p)), `${p} renders no badge of its own`)
})

test('the decoration is matched to its row in exactly one place', (t) => {
  const hook = read('src/renderer/hooks/useShareFiles.ts')
  t.absent(/phase === 'verifying'|phase === 'preparing'/.test(hook),
    'useShareFiles no longer phase-matches; rowView.js does')
})
