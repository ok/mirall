import test from 'brittle'
import os from 'bare-os'
import fs from 'bare-fs'
import path from 'bare-path'
import { initStore } from '../../src/shared/core/store.js'
import {
  initProfile, setProfile, getLocalPublicKeyHex,
  markOwnMembership, captureJoinerMembership,
} from '../../src/shared/spaces/profile.js'

// captureJoinerMembership is the offline-co-member-approval convergence fix: at approval time the
// approver downloads a COMPLETE copy of the joiner's profile core while the joiner is still
// connected, so a joiner that disconnects right after approval still has a peer holding its whole
// core (member/<S> included) to serve to the owner. A sparse record-read is NOT enough — it leaves
// gaps the owner's contiguous follow can't reconstruct from us. This guards the helper's contract;
// the multi-peer convergence itself is exercised by the flow suite + the raw transitive test.
// Root cause + design: .claude/tasks/plan-offline-member-convergence-fix.md.

function tmp (label) {
  const dir = path.join(os.tmpdir(), `capture-jm-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

test('captureJoinerMembership: disabled / complete-copy / unreachable — bounded and never throws', async (t) => {
  const root = tmp('store')
  initStore(path.join(root, 'app-storage'))
  await initProfile()
  await setProfile({ displayName: 'Self', avatar: null })
  await markOwnMembership('spaceabc00000000')
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

  const self = getLocalPublicKeyHex()
  const S = 'spaceabc00000000'

  // timeoutMs <= 0 disables the capture entirely (the kill-switch), returning fast without store work.
  const t0 = Date.now()
  t.is(await captureJoinerMembership(self, S, { timeoutMs: 0 }), false, 'timeoutMs:0 disables capture')
  t.ok(Date.now() - t0 < 50, 'disabled path returns immediately')

  // Our own profile core is fully present locally → we already hold a complete copy → true (fast).
  t.is(await captureJoinerMembership(self, S, { timeoutMs: 3000, intervalMs: 25 }), true,
    'fully-present core → captured true')

  // A key we hold no core for and have no peer to fetch from → never completes → bounded false, no throw.
  const unreachable = 'ab'.repeat(32)
  t.is(await captureJoinerMembership(unreachable, S, { timeoutMs: 150, intervalMs: 25 }), false,
    'unreachable key → bounded false, no throw')
})
