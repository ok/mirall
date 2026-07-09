import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'

const root = new URL('../../', import.meta.url)
const read = (p) => readFileSync(fileURLToPath(new URL(p, root)), 'utf8')

const IND = 'src/renderer/components/cards/PeerDownloadIndicator.tsx'
const FILECARD_LANE = 'src/renderer/components/cards/FileCardLane.tsx'
const SHARE_FILE_ROW = 'src/renderer/components/cards/ShareFileRow.tsx'

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
  const fc = read(FILECARD_LANE)
  t.ok(fc.includes('min-w-[180px]'), 'FileCard indicator floor is 180px')
  t.absent(fc.includes('min-w-[160px]'), 'FileCard no longer floors at 160px')
  const fv = read(SHARE_FILE_ROW)
  t.ok(fv.includes('min-w-[180px]'), 'ShareFileRow indicator floor is 180px')
  t.absent(fv.includes('min-w-[120px]'), 'ShareFileRow no longer floors at 120px')
})
