// Real-Chromium harness for the sender-side "who is downloading" UI. Mounts the REAL
// <PeerDownloadIndicator> at several lane widths and the <PeerDownloadRow>, and asserts the
// contract the unit/AX-tree layers can't see:
//   - the collapsed meta never clips at any lane width or locale;
//   - tokens shed lowest-priority first: the count word shows only on a wide (FolderView) lane,
//     ETA sheds next, speed is always kept;
//   - aria-valuetext still carries count · speed · ETA even where the visible line is compacted;
//   - the per-peer row puts the name on the left and right-aligns the avatar + bar at ~half width,
//     the name yields under pressure while speed · ETA stays whole, and a warmup row shows a "%".
import { createRoot } from 'react-dom/client'
import i18n from './../../src/renderer/i18n.js'
import PeerDownloadIndicator from './../../src/renderer/components/cards/PeerDownloadIndicator.js'
import PeerDownloadRow from './../../src/renderer/components/cards/PeerDownloadRow.js'
import type { SpaceMember, PeerDownloadSummary } from './../../src/renderer/types.js'

interface LaneFlags {
  folder: boolean
  file: boolean
  narrow: boolean
  tiny: boolean
}

interface HarnessResults {
  pass: boolean
  error: string | null
  clipFolder: boolean
  clipFile: boolean
  clipNarrow: boolean
  clipTiny: boolean
  clipDe: boolean
  countShown: LaneFlags
  speedAll: boolean
  etaNarrow: boolean
  etaTiny: boolean
  ariaFile: string
  ariaTiny: string
  rowLiveText: string
  rowLiveValueText: string
  rowLiveNameClipped: boolean
  rowLiveMetaClipped: boolean
  rowLiveBarRatio: number
  rowLiveBarRightGap: number
  rowLiveNameAvatarGap: number
  rowWarmText: string
  rowOffText: string
}

declare global {
  interface Window {
    __results: HarnessResults
  }
}

// Decimal MB so the rendered labels stay clean under formatSize's 1000-based scaling
// (5 MB/s, 50/100 MB) — the harness models a 5 MB/s stream, not 5 MiB/s.
const MB = 1000 * 1000
// A long name so the per-peer row is genuinely under width pressure: the name must
// truncate while the speed · ETA stays whole.
const alice: SpaceMember = { publicKey: 'k1', driveKey: 'd1', displayName: 'Alexandra Featherstonehaugh', online: true }
const bob: SpaceMember = { publicKey: 'k2', driveKey: 'd2', displayName: 'Bob', online: false }
// 50/100 MB at 5 MB/s → speed "5 MB/s", remaining 50 MB ÷ 5 MB/s = 10 → ETA "10s left", pct 50%.
const summary: PeerDownloadSummary = { spaceId: 's1', path: '/file.bin', peerKeys: ['k1'], pausedKeys: [], bytes: 50 * MB, total: 100 * MB, avgSpeed: 5 * MB }

// Representative lane widths: FolderView basis-72 (count word shown), FileCard basis-56 (count
// relies on avatars), the bumped 180px floor, and an ultra-narrow lane (speed only).
const LANES: Array<{ id: string; w: number }> = [
  { id: 'folder', w: 288 },
  { id: 'file', w: 224 },
  { id: 'narrow', w: 180 },
  { id: 'tiny', w: 150 },
]

const container = document.getElementById('root') as HTMLElement
createRoot(container).render(
  <div style={{ padding: 16 }}>
    {LANES.map(({ id, w }) => (
      <div key={id} data-ind={id} style={{ width: w, marginBottom: 8 }}>
        <PeerDownloadIndicator summary={summary} members={[alice]} open={false} onToggle={() => {}} controlsId={`ind-${id}`} />
      </div>
    ))}
    <div style={{ width: 320 }}>
      <ul data-test="row-live">
        <PeerDownloadRow member={alice} bytes={50 * MB} total={100 * MB} avgSpeed={5 * MB} />
      </ul>
    </div>
    <ul data-test="row-warm">
      <PeerDownloadRow member={alice} bytes={50 * MB} total={100 * MB} avgSpeed={0} />
    </ul>
    <ul data-test="row-off">
      <PeerDownloadRow member={bob} bytes={30 * MB} total={100 * MB} avgSpeed={0} />
    </ul>
  </div>,
)

function el(sel: string): HTMLElement | null {
  const node = document.querySelector(sel)
  return node instanceof HTMLElement ? node : null
}
function textOf(sel: string): string {
  return el(sel)?.textContent?.trim() ?? ''
}
function valueText(sel: string): string {
  return el(`${sel} [role="progressbar"]`)?.getAttribute('aria-valuetext') ?? ''
}
function clipped(target: HTMLElement | null): boolean {
  return target ? target.scrollWidth > target.clientWidth : true
}
function lineClipped(id: string): boolean {
  return clipped(el(`[data-ind="${id}"] .truncate`))
}
function tokenShown(id: string, token: string): boolean {
  const node = el(`[data-ind="${id}"] [data-token="${token}"]`)
  return node != null && node.offsetWidth > 0
}

const FAIL: HarnessResults = {
  pass: false,
  error: null,
  clipFolder: true,
  clipFile: true,
  clipNarrow: true,
  clipTiny: true,
  clipDe: true,
  countShown: { folder: false, file: true, narrow: true, tiny: true },
  speedAll: false,
  etaNarrow: false,
  etaTiny: true,
  ariaFile: '',
  ariaTiny: '',
  rowLiveText: '',
  rowLiveValueText: '',
  rowLiveNameClipped: false,
  rowLiveMetaClipped: true,
  rowLiveBarRatio: 0,
  rowLiveBarRightGap: 999,
  rowLiveNameAvatarGap: 999,
  rowWarmText: '',
  rowOffText: '',
}

async function measure(): Promise<void> {
  try {
    // Pin English so the assertions are independent of the host machine's locale, and measure
    // every EN lane + row FIRST so the English aria/row assertions below see English text.
    await i18n.changeLanguage('en')
    await new Promise((r) => setTimeout(r, 40))
    const liveLi = el('[data-test="row-live"] li')
    const liveBar = el('[data-test="row-live"] [role="progressbar"]')
    const liveName = el('[data-test="row-live"] .font-bold')
    const liveAvatar = el('[data-test="row-live"] .relative')
    const liRect = liveLi?.getBoundingClientRect()
    const barRect = liveBar?.getBoundingClientRect()
    const nameRect = liveName?.getBoundingClientRect()
    const avatarRect = liveAvatar?.getBoundingClientRect()

    const results: HarnessResults = {
      error: null,
      clipFolder: lineClipped('folder'),
      clipFile: lineClipped('file'),
      clipNarrow: lineClipped('narrow'),
      clipTiny: lineClipped('tiny'),
      clipDe: true,
      countShown: {
        folder: tokenShown('folder', 'count'),
        file: tokenShown('file', 'count'),
        narrow: tokenShown('narrow', 'count'),
        tiny: tokenShown('tiny', 'count'),
      },
      speedAll: ['folder', 'file', 'narrow', 'tiny'].every((id) => tokenShown(id, 'speed')),
      etaNarrow: tokenShown('narrow', 'eta'),
      etaTiny: tokenShown('tiny', 'eta'),
      ariaFile: valueText('[data-ind="file"]'),
      ariaTiny: valueText('[data-ind="tiny"]'),
      rowLiveText: textOf('[data-test="row-live"]'),
      rowLiveValueText: valueText('[data-test="row-live"]'),
      rowLiveNameClipped: clipped(el('[data-test="row-live"] .font-bold')),
      rowLiveMetaClipped: clipped(el('[data-test="row-live"] .tabular-nums')),
      rowLiveBarRatio: liRect && barRect && liRect.width > 0 ? barRect.width / liRect.width : 0,
      rowLiveBarRightGap: liRect && barRect ? liRect.right - barRect.right : 999,
      rowLiveNameAvatarGap: nameRect && avatarRect ? avatarRect.left - nameRect.right : 999,
      rowWarmText: textOf('[data-test="row-warm"]'),
      rowOffText: textOf('[data-test="row-off"]'),
      pass: false,
    }

    // German worst case (count word + speed + verbose German ETA) at a FolderView-width lane,
    // in its own DOM host. Done last so flipping the locale can't disturb the EN measurements.
    await i18n.changeLanguage('de')
    const deHost = document.createElement('div')
    deHost.setAttribute('data-ind', 'de')
    deHost.style.width = '288px'
    document.body.appendChild(deHost)
    createRoot(deHost).render(
      <PeerDownloadIndicator summary={summary} members={[alice]} open={false} onToggle={() => {}} controlsId="ind-de" />,
    )
    await new Promise((r) => setTimeout(r, 80))
    results.clipDe = lineClipped('de')
    results.pass =
      // No lane clips at any width or locale.
      !results.clipFolder && !results.clipFile && !results.clipNarrow && !results.clipTiny && !results.clipDe &&
      // The count word rides only the wide folder lane; the avatar stack carries it elsewhere.
      results.countShown.folder && !results.countShown.file && !results.countShown.narrow && !results.countShown.tiny &&
      // Speed is always kept; ETA sheds only on the tiniest lane.
      results.speedAll && results.etaNarrow && !results.etaTiny &&
      // aria-valuetext stays complete even where the visible line is compacted.
      results.ariaFile.includes('50%') && results.ariaFile.includes('downloading') && results.ariaFile.includes('10s left') &&
      results.ariaTiny.includes('downloading') && results.ariaTiny.includes('10s left') &&
      // Per-peer row contract (unchanged): the name yields, the speed · ETA does not.
      results.rowLiveText.includes('5 MB/s') &&
      results.rowLiveText.includes('10s left') &&
      results.rowLiveValueText.includes('10s left') &&
      results.rowLiveNameClipped &&
      !results.rowLiveMetaClipped &&
      results.rowLiveBarRightGap >= 0 &&
      results.rowLiveBarRightGap < 8 &&
      results.rowLiveBarRatio > 0.4 &&
      results.rowLiveBarRatio < 0.6 &&
      results.rowLiveNameAvatarGap > 4 &&
      results.rowLiveNameAvatarGap < 20 &&
      results.rowWarmText.includes('50%') &&
      results.rowOffText.includes('Waiting')
    window.__results = results
  } catch (e) {
    window.__results = { ...FAIL, error: e instanceof Error ? e.message : String(e) }
  }
}

// Wait for the app fonts so the clip/width measurements use real glyph metrics. measure() is
// async (it flips the locale for the German lane), so kick it off and let it settle.
document.fonts.ready.then(() => { setTimeout(() => { void measure() }, 80) })
