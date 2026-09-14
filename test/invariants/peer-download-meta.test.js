import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'

const root = new URL('../../', import.meta.url)
const read = (p) => readFileSync(fileURLToPath(new URL(p, root)), 'utf8')

const IND = 'src/renderer/components/cards/PeerDownloadIndicator.tsx'
const ROW_LANE = 'src/renderer/components/cards/RowLane.tsx'
const SHARE_FILE_ROW = 'src/renderer/components/cards/ShareFileRow.tsx'
const FILE_CARD = 'src/renderer/components/cards/FileCard.tsx'

const indSrc = read(IND)
const indFlat = indSrc.replace(/\n/g, ' ')

test('REGRESSION (FIX-1): meta column is a @container/lane query context', (t) => {
  t.ok(/@container\/lane[^"]*flex-grow[^"]*flex-col/.test(indFlat),
    'flex-grow meta column carries @container/lane')
})

test('REGRESSION (FIX-2): count word gated @min-[200px], conditional; speed never gated', (t) => {
  t.ok(/key: 'count'[\s\S]*?@min-\[200px\]\/lane:inline/.test(indSrc),
    'count token gated at @min-[200px]/lane')
  t.ok(/className: hasRate \? 'hidden @min-\[200px\]\/lane:inline' : ''/.test(indSrc),
    'count gate is conditional on hasRate so an all-paused line is never hidden')
  const speedLine = indSrc.match(/key: 'speed',[^}]*}/)
  t.ok(speedLine, 'speed token present')
  t.absent(/@min-/.test(speedLine?.[0] ?? '@min-'), 'speed token is never gated (always visible)')
})

test('REGRESSION (FIX-3): ETA sheds after count, before speed (@min-[120px])', (t) => {
  t.ok(/key: 'eta'[\s\S]*?@min-\[120px\]\/lane:inline/.test(indSrc),
    'eta token gated at @min-[120px]/lane')
})

test('REGRESSION (FIX-4): aria-valuetext keeps pct + count + paused + speed + eta', (t) => {
  t.ok(/progressValueText\(pct, activeLabel, pausedLabel, speed, eta\)/.test(indSrc),
    'valueText keeps every token regardless of visible compaction')
})

test('REGRESSION (FIX-5): lane floors bumped so speed·ETA always fits', (t) => {
  // One lane component serves both row kinds now, so the floor is asserted once — and the two
  // per-kind basis widths it still varies live there with it.
  const lane = read(ROW_LANE)
  t.ok(lane.includes('min-w-[180px]'), 'the indicator floor is 180px')
  t.absent(lane.includes('min-w-[160px]'), 'no longer floors at 160px')
  t.absent(lane.includes('min-w-[120px]'), 'no longer floors at 120px')
  t.ok(lane.includes('basis-56') && lane.includes('basis-72'), 'both kinds keep their own basis')
  for (const p of [SHARE_FILE_ROW, FILE_CARD]) {
    t.absent(/min-w-\[\d+px\]|basis-\d/.test(read(p)), `${p} carries no lane width of its own`)
  }
})
