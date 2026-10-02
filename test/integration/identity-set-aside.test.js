import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setAsideLockedData } from '../../src/shared/core/identity-set-aside.js'
import { tmpDir } from '../helpers/bare-tmp.js'

function lockedProfile(t) {
  const root = tmpDir('identity-set-aside')
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })
  const storage = path.join(root, 'app-storage')
  fs.mkdirSync(path.join(storage, 'db'), { recursive: true })
  fs.writeFileSync(path.join(storage, 'CORESTORE'), 'lock')
  fs.writeFileSync(path.join(storage, 'db', 'CURRENT'), 'rocks')
  fs.writeFileSync(path.join(storage, 'install-id'), 'abc')
  for (const name of ['identity.enc', 'space-keys.enc', 'backup-state.json', 'kek.enc', 'relay-ticket.enc', 'config.json']) {
    fs.writeFileSync(path.join(root, name), name)
  }
  return { root, storage }
}

test('the locked store and the envelopes that belong to it move aside together', (t) => {
  const { root, storage } = lockedProfile(t)
  const folder = setAsideLockedData(storage, { now: new Date('2026-09-29T08:30:15.123Z') })

  t.is(folder, path.join(root, 'app-storage.locked-2026-09-29T08-30-15'))
  t.alike(fs.readdirSync(storage), [], 'the store directory stays, empty, for a fresh install')
  for (const moved of ['CORESTORE', 'install-id', path.join('db', 'CURRENT'), 'identity.enc', 'space-keys.enc', 'backup-state.json']) {
    t.ok(fs.existsSync(path.join(folder, moved)), moved)
  }
  for (const kept of ['kek.enc', 'relay-ticket.enc', 'config.json']) {
    t.ok(fs.existsSync(path.join(root, kept)), `${kept} stays: it belongs to the device, not the identity`)
  }
})

test('an envelope inside the store and one beside it both survive the move', (t) => {
  const { root, storage } = lockedProfile(t)
  fs.writeFileSync(path.join(storage, 'identity.enc'), 'inside')
  const folder = setAsideLockedData(storage)
  t.is(fs.readFileSync(path.join(folder, 'identity.enc'), 'utf-8'), 'inside')
  t.is(fs.readFileSync(path.join(folder, 'beside-identity.enc'), 'utf-8'), 'identity.enc')
  t.absent(fs.existsSync(path.join(root, 'identity.enc')))
})

test('a second set-aside in the same second gets its own folder', (t) => {
  const { storage } = lockedProfile(t)
  const now = new Date('2026-09-29T08:30:15Z')
  const first = setAsideLockedData(storage, { now })
  fs.writeFileSync(path.join(storage, 'CORESTORE'), 'again')
  const second = setAsideLockedData(storage, { now })
  t.not(second, first)
  t.ok(fs.existsSync(path.join(second, 'CORESTORE')))
})

test('a KEK and relay seed inside the store stay: they belong to the device', (t) => {
  const { storage } = lockedProfile(t)
  fs.writeFileSync(path.join(storage, 'kek.enc'), 'kek')
  fs.writeFileSync(path.join(storage, 'relay-ticket.enc'), 'relay')
  const folder = setAsideLockedData(storage)
  t.alike(fs.readdirSync(storage).sort(), ['kek.enc', 'relay-ticket.enc'])
  t.absent(fs.existsSync(path.join(folder, 'kek.enc')))
})

test('a move that fails part-way is undone, so no folder holds half an identity', (t) => {
  const { root, storage } = lockedProfile(t)
  const before = fs.readdirSync(storage).sort()
  let moves = 0
  const rename = (from, to) => {
    if (++moves === 3) throw new Error('EPERM: a handle is open')
    fs.renameSync(from, to)
  }
  t.exception(() => setAsideLockedData(storage, { rename }), /EPERM/)
  t.alike(fs.readdirSync(storage).sort(), before, 'every entry is back')
  t.ok(fs.existsSync(path.join(root, 'identity.enc')), 'and so is the envelope')
  t.alike(fs.readdirSync(root).filter((n) => n.startsWith('app-storage.locked-')), [], 'the half-filled folder is gone')
})
