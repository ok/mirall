import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { scopeForEvent } from '../../src/shared/core/ipc.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(here, '..', '..', 'src')

function walk (dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(js|ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

// Every worker->renderer event declares its EDA bucket here. Adding an event:* without classifying
// it fails this guard — the tripwire against re-growing an off-channel status event.
//   poke       — thin hint auto-fanned into event:reconcile by POKE_SCOPE (level-triggered)
//   decoration — high-frequency progress, holds no status
//   awareness  — ephemeral cross-peer soft-state (re-announce + TTL)
//   signal     — one-shot lifecycle / notification (durably backstopped or cosmetic)
//   snapshot   — bootstrap
const TAXONOMY = {
  'event:reconcile': 'poke',
  'event:files-updated': 'poke',
  'event:shares-updated': 'poke',
  'event:share-files-updated': 'poke',
  'event:members-updated': 'poke',
  'event:mirrors-updated': 'poke',
  'event:member-left': 'poke',
  'event:member-avatar-updated': 'poke',
  'event:member-join-request': 'poke',
  'event:join-requests-updated': 'poke',
  'event:foreign-folder-mount-status': 'poke',
  'event:owned-folder-mount-status': 'poke',
  'event:decoration': 'decoration',
  'event:awareness': 'awareness',
  'event:member-joined': 'signal',
  'event:membership-granted': 'signal',
  'event:membership-denied': 'signal',
  'event:membership-creator-divergence': 'signal',
  'event:owned-folder-scan-completed': 'signal',
  'event:transfer-complete': 'signal',
  'event:transfer-error': 'signal',
  'event:transfer-paused': 'signal',
  'event:transfer-superseded': 'signal',
  'event:transfer-removed': 'signal',
  'event:leave-progress': 'signal',
  'event:network-status': 'signal',
  'event:profile-needed': 'signal',
  'event:worker-ready': 'signal',
  'event:owned-folder-preview-progress': 'signal',
  'event:foreign-folder-preview-progress': 'signal',
  'event:state': 'snapshot',
}

test('every emitted worker event is classified in the EDA taxonomy', (t) => {
  const emitted = new Set()
  const re = /emit\(\s*['"`](event:[a-z-]+)/g
  for (const file of walk(SRC)) {
    if (!(file.includes('/worker/') || file.includes('/shared/') || file.includes('/main/'))) continue
    const src = readFileSync(file, 'utf8')
    for (let m; (m = re.exec(src));) emitted.add(m[1])
  }
  t.ok(emitted.size > 10, 'found the emitted events')
  for (const e of emitted) t.ok(TAXONOMY[e], `${e} is classified in the EDA taxonomy`)
})

test('every poke event fans a reconcile hint via POKE_SCOPE (no poke without a fan-out)', (t) => {
  for (const [event, bucket] of Object.entries(TAXONOMY)) {
    if (bucket !== 'poke' || event === 'event:reconcile') continue
    t.ok(scopeForEvent(event, { spaceId: 'S', shareId: 'X' }) !== null, `${event} maps to a reconcile scope`)
  }
})

test('no non-poke event accidentally fans a reconcile hint', (t) => {
  for (const [event, bucket] of Object.entries(TAXONOMY)) {
    if (bucket === 'poke') continue
    t.is(scopeForEvent(event, { spaceId: 'S', shareId: 'X' }), null, `${event} does not fan a reconcile hint`)
  }
})

// REGRESSION: the creator-divergence CLEAR transition emitted nothing, so an open view kept the
// "approvals paused" banner until an unrelated refresh. The set path emits; the clear must too.
// The behavioral emit rides the handshake/grant flow; this pins the invariant that clear is never
// silent (both worker call sites emit next to the clear).
test('REGRESSION: the creator-divergence clear transition is never silent', (t) => {
  const read = (rel) => readFileSync(path.join(SRC, rel), 'utf8')
  const emitRe = /ipc(Ref)?\.emit\(\s*['"`]event:membership-creator-divergence/
  // Assert EVERY clearCreatorDivergence call site emits nearby — not just that one match exists —
  // so adding a new silent clear site fails the guard.
  const eachClearEmits = (rel) => {
    const lines = read(rel).split('\n')
    let sites = 0
    lines.forEach((line, i) => {
      if (!/\bclearCreatorDivergence\(spaceId\)/.test(line)) return
      sites++
      t.ok(emitRe.test(lines.slice(i, i + 3).join('\n')), `${rel}: clear at line ${i + 1} emits the divergence event`)
    })
    t.ok(sites > 0, `${rel}: has a divergence clear site`)
  }
  eachClearEmits('shared/transfer/swarm.js')
  eachClearEmits('worker/main.js')
})
