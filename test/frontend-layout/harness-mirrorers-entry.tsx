// Real-Chromium harness for the "mirrored by" sidebar widget. Mounts the REAL <MirroredByWidget>
// (fed by the fake bridge's space:mirrors) and asserts the stacked facepile renders a capped avatar
// stack + "+N" overflow chip, encodes each peer's sync state as a ring colour (synced/synced-pulse/
// paused — never opacity), shows the heading, and carries an accessible name listing the mirrors and
// their states — the a11y + colour contract can't be measured without a real AX tree + CSS.
import { createRoot } from 'react-dom/client'
import i18n from './../../src/renderer/i18n.js'
import MirroredByWidget from './../../src/renderer/components/cards/MirroredByWidget.js'
import type { MirrorParticipant, SpaceMember } from './../../src/renderer/types.js'

interface HarnessResults {
  pass: boolean
  error: string | null
  heading: string
  ariaLabel: string
  avatarCount: number
  overflowText: string
  hasSyncedRing: boolean
  hasSyncingPulse: boolean
  hasPausedRing: boolean
  hasOpacity: boolean
}

declare global {
  interface Window {
    __results: HarnessResults
    __fake: { SPACE_ID: string; SHARE_ID: string; OWNER_PK: string }
    __HARNESS_CFG?: { mirrors?: MirrorParticipant[] }
  }
}

const { SPACE_ID, SHARE_ID, OWNER_PK } = window.__fake
const KEYS = [OWNER_PK, 'peer-b-key', 'peer-c-key', 'peer-d-key', 'peer-e-key', 'peer-f-key']
const STATES = ['synced', 'syncing', 'paused', 'synced', 'synced', 'synced'] as const
window.__HARNESS_CFG = {
  mirrors: KEYS.map((k, i): MirrorParticipant => ({ mirrorer: k, shareId: SHARE_ID, state: STATES[i], mountedAt: 0 })),
}
const members: SpaceMember[] = KEYS.map((k, i) => ({ publicKey: k, driveKey: 'd'.repeat(64), displayName: 'Peer ' + i, online: true }))

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="bg-surface p-8" style={{ width: 320 }}>
    <div id="host">
      <MirroredByWidget spaceId={SPACE_ID} shareId={SHARE_ID} members={members} />
    </div>
  </div>,
)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function publishError(error: string): void {
  window.__results = {
    pass: false, error, heading: '', ariaLabel: '', avatarCount: -1, overflowText: '',
    hasSyncedRing: false, hasSyncingPulse: false, hasPausedRing: false, hasOpacity: false,
  }
}

async function run(): Promise<void> {
  const deadline = Date.now() + 5000
  let facepile: Element | null = null
  while (!facepile && Date.now() < deadline) {
    await sleep(50)
    facepile = document.querySelector('#host [role="img"]')
  }
  if (!facepile) return publishError('MirroredByWidget facepile never rendered')

  const heading = (document.querySelector('#host h3')?.textContent ?? '').trim()
  const ariaLabel = facepile.getAttribute('aria-label') ?? ''
  const children = Array.from(facepile.children)
  const lastText = (children[children.length - 1]?.textContent ?? '').trim()
  const hasOverflowChip = /^\+\d+$/.test(lastText)
  const avatarCount = children.length - (hasOverflowChip ? 1 : 0)
  const overflowText = hasOverflowChip ? lastText : ''
  const hasSyncedRing = !!document.querySelector('#host .avatar-ring-synced')
  const hasSyncingPulse = !!document.querySelector('#host .avatar-ring-syncing-active')
  const hasPausedRing = !!document.querySelector('#host .avatar-ring-paused')
  const hasOpacity = !!document.querySelector('#host .opacity-50')

  window.__results = {
    pass:
      heading === i18n.t('folder.mirroredByHeading') &&
      avatarCount === 5 && overflowText === '+1' &&
      hasSyncedRing && hasSyncingPulse && hasPausedRing && !hasOpacity,
    error: null,
    heading,
    ariaLabel,
    avatarCount,
    overflowText,
    hasSyncedRing,
    hasSyncingPulse,
    hasPausedRing,
    hasOpacity,
  }
}

run()
