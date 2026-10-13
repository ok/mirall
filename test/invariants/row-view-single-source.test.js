import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'

const root = new URL('../../', import.meta.url)
const read = (p) => readFileSync(fileURLToPath(new URL(p, root)), 'utf8')

const FILE_ROW = 'src/renderer/components/cards/FileRow.tsx'
const LANE = 'src/renderer/components/cards/RowLane.tsx'

// The two file-row kinds once decided their lane in two places, at two layers, with two precedence
// orders — and drifted into three user-visible divergences. These pin the single source down.
test('the file row does not derive its own lane', (t) => {
  const src = read(FILE_ROW)
  t.ok(/deriveRowView\(/.test(src), `${FILE_ROW} uses the shared view-model`)
  t.absent(/showDownloadProgressBar|showIndexProgressBar|showPausedProgressBar/.test(src),
    `${FILE_ROW} has no hand-rolled lane gate`)
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
  t.absent(/<Badge\b/.test(read(FILE_ROW)), `${FILE_ROW} renders no badge of its own`)
})

test('the decoration is matched to its row in exactly one place', (t) => {
  const hook = read('src/renderer/hooks/useShareFiles.ts')
  t.absent(/phase === 'verifying'|phase === 'preparing'/.test(hook),
    'useShareFiles no longer phase-matches; rowView.js does')
})
