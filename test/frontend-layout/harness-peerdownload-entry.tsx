// Real-Chromium harness for the sender-side "who is downloading" UI. Mounts the REAL
// <PeerDownloadIndicator> at several lane widths and the <PeerDownloadRow>, and asserts the
// contract the unit/AX-tree layers can't see:
//   - the collapsed meta never clips at any lane width or locale;
//   - tokens shed lowest-priority first: the count word shows only on a wide (FolderScreen) lane,
//     ETA sheds next, speed is always kept;
//   - aria-valuetext still carries count · speed · ETA even where the visible line is compacted;
//   - the per-peer pill reads avatar, name, a fixed-width bar and the percentage; in a narrow list
//     the name yields while the bar and the percentage stay whole, the pill never overflows, and
//     aria-valuetext keeps the speed · ETA the pill leaves out;
//   - the expanded list's groups come in order, each h4 labels its list, and a live peer sits under
//     Downloading only while it moves or is paused; waiting for indexing or offline is Waiting.
import './harness-bootstrap.js'
import { createRoot } from 'react-dom/client'
import i18n from '../../src/renderer/platform/i18n.js'
import PeerDownloadIndicator from '../../src/renderer/components/cards/PeerDownloadIndicator.js'
import PeerDownloadRow from '../../src/renderer/components/cards/PeerDownloadRow.js'
import PeerDownloadDropdown from '../../src/renderer/components/cards/PeerDownloadDropdown.js'
import type { SpaceMember, PeerDownloadSummary, FileRecipient } from '../../src/renderer/types/types.js'

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
  rowLiveBarWidth: number
  rowLiveOverflow: number
  rowLiveNameAvatarGap: number
  rowWarmText: string
  rowOffText: string
  groups: GroupRead[]
}

interface GroupRead {
  label: string
  labelled: boolean
  names: string[]
}

declare global {
  interface Window {
    __results: HarnessResults
  }
}

// Decimal MB so the rendered labels stay clean under formatSize's 1000-based scaling
// (5 MB/s, 50/100 MB) — the harness models a 5 MB/s stream, not 5 MiB/s.
const MB = 1000 * 1000
// A long name so the per-peer pill is genuinely under width pressure: the name must
// truncate while the bar and the percentage stay whole.
const alice: SpaceMember = { publicKey: 'k1', displayName: 'Alexandra Featherstonehaugh', online: true }
const bob: SpaceMember = { publicKey: 'k2', displayName: 'Bob', online: false }
// 50/100 MB at 5 MB/s → speed "5 MB/s", remaining 50 MB ÷ 5 MB/s = 10 → ETA "10s left", pct 50%.
const summary: PeerDownloadSummary = { spaceId: 's1', path: '/file.bin', personKeys: ['k1'], pausedKeys: [], waitingKeys: [], bytes: 50 * MB, total: 100 * MB, avgSpeed: 5 * MB }

// The expanded list: the live peers come from the case's canned detail (cases.mjs), keyed as here.
const person = (publicKey: string, displayName: string, online = true): SpaceMember => ({ publicKey, displayName, online })
const LIST_MEMBERS: SpaceMember[] = [
  person('owner', 'Owner'),
  person('mo', 'Mo'),
  person('pia', 'Pia'),
  person('wes', 'Wes'),
  person('otto', 'Otto', false),
  person('opal', 'Opal', false),
  person('hana', 'Hana'),
  person('nina', 'Nina'),
]
const LIST_RECIPIENTS: FileRecipient[] = [{ shareId: '__loose__', path: '/file.bin', personKey: 'hana', contentHash: 'h1', ts: 1 }]
const EXPECTED_GROUPS: Array<Omit<GroupRead, 'labelled'>> = [
  { label: 'Downloading', names: ['Mo', 'Pia'] },
  { label: 'Waiting', names: ['Otto', 'Opal', 'Wes'] },
  { label: 'Have it', names: ['Hana'] },
  { label: 'Not yet', names: ['Nina'] },
]

// Representative lane widths: a folder row basis-72 (count word shown), a loose row basis-56 (count
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
        <PeerDownloadIndicator summary={summary} members={[alice]} haveCount={0} open={false} onToggle={() => {}} controlsId={`ind-${id}`} />
      </div>
    ))}
    <div style={{ width: 200 }}>
      <ul data-test="row-live" className="flex flex-wrap">
        <PeerDownloadRow member={alice} bytes={50 * MB} total={100 * MB} avgSpeed={5 * MB} />
      </ul>
    </div>
    <ul data-test="row-warm">
      <PeerDownloadRow member={alice} bytes={50 * MB} total={100 * MB} avgSpeed={0} />
    </ul>
    <ul data-test="row-off">
      <PeerDownloadRow member={bob} bytes={30 * MB} total={100 * MB} avgSpeed={0} />
    </ul>
    <div style={{ width: 480 }}>
      <PeerDownloadDropdown id="list" spaceId="s1" path="/file.bin" members={LIST_MEMBERS} recipients={LIST_RECIPIENTS} contentHash="h1" ownerKey="owner" />
    </div>
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

// Each group as a reader meets it: the h4's text, whether its list is labelled by it, and the names
// in that list.
function readGroups(): GroupRead[] {
  return [...document.querySelectorAll('#list h4')].map((h) => {
    const list = document.querySelector(`#list ul[aria-labelledby="${h.id}"]`)
    return {
      label: h.textContent?.trim() ?? '',
      labelled: list != null && h.id !== '',
      names: [...(list?.querySelectorAll('li') ?? [])].map((li) => li.querySelector('.font-semibold')?.textContent?.trim() ?? ''),
    }
  })
}

function groupsMatch(groups: GroupRead[]): boolean {
  return groups.length === EXPECTED_GROUPS.length &&
    groups.every((g, i) => g.labelled && g.label === EXPECTED_GROUPS[i].label && g.names.join() === EXPECTED_GROUPS[i].names.join())
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
  rowLiveBarWidth: 0,
  rowLiveOverflow: 999,
  rowLiveNameAvatarGap: 999,
  rowWarmText: '',
  rowOffText: '',
  groups: [],
}

async function measure(): Promise<void> {
  try {
    // Pin English so the assertions are independent of the host machine's locale, and measure
    // every EN lane + row FIRST so the English aria/row assertions below see English text.
    await i18n.changeLanguage('en')
    await new Promise((r) => setTimeout(r, 40))
    const liveLi = el('[data-test="row-live"] li')
    const liveBar = el('[data-test="row-live"] [role="progressbar"]')
    const liveName = el('[data-test="row-live"] .font-semibold')
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
      rowLiveNameClipped: clipped(el('[data-test="row-live"] .font-semibold')),
      rowLiveMetaClipped: clipped(el('[data-test="row-live"] .tabular-nums')),
      rowLiveBarWidth: barRect?.width ?? 0,
      rowLiveOverflow: liRect ? liRect.right - (liveLi?.parentElement?.getBoundingClientRect().right ?? 0) : 999,
      rowLiveNameAvatarGap: nameRect && avatarRect ? nameRect.left - avatarRect.right : 999,
      rowWarmText: textOf('[data-test="row-warm"]'),
      rowOffText: textOf('[data-test="row-off"]'),
      groups: readGroups(),
      pass: false,
    }

    // German worst case (count word + speed + verbose German ETA) at a FolderScreen-width lane,
    // in its own DOM host. Done last so flipping the locale can't disturb the EN measurements.
    await i18n.changeLanguage('de')
    const deHost = document.createElement('div')
    deHost.setAttribute('data-ind', 'de')
    deHost.style.width = '288px'
    document.body.appendChild(deHost)
    createRoot(deHost).render(
      <PeerDownloadIndicator summary={summary} members={[alice]} haveCount={0} open={false} onToggle={() => {}} controlsId="ind-de" />,
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
      // Per-peer pill contract: the name yields, the bar and the percentage do not, the pill stays
      // inside its list, and aria-valuetext keeps the speed · ETA the pill leaves out.
      results.rowLiveText.includes('50%') &&
      results.rowLiveValueText.includes('5 MB/s') &&
      results.rowLiveValueText.includes('10s left') &&
      results.rowLiveNameClipped &&
      !results.rowLiveMetaClipped &&
      results.rowLiveOverflow <= 0 &&
      results.rowLiveBarWidth === 48 &&
      results.rowLiveNameAvatarGap > 4 &&
      results.rowLiveNameAvatarGap < 10 &&
      results.rowWarmText.includes('50%') &&
      results.rowOffText.includes('Waiting') &&
      // The expanded list: groups in order, each heading labelling its list, each peer where its
      // row's own label puts it.
      groupsMatch(results.groups)
    window.__results = results
  } catch (e) {
    window.__results = { ...FAIL, error: e instanceof Error ? e.message : String(e) }
  }
}

// Wait for the app fonts so the clip/width measurements use real glyph metrics. measure() is
// async (it flips the locale for the German lane), so kick it off and let it settle.
document.fonts.ready.then(() => { setTimeout(() => { void measure() }, 80) })
