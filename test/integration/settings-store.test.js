import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { tmpDir } from '../helpers/bare-tmp.js'
import { loadSettings, getSettings, updateSettings, _resetSettingsForTests } from '../../src/shared/core/settings-store.js'
import { defaultSettings } from '../../src/shared/core/settings-rules.js'

function home(t) {
  const root = tmpDir('settings-store', t)
  const storage = path.join(root, 'app-storage')
  fs.mkdirSync(storage, { recursive: true })
  t.teardown(() => _resetSettingsForTests())
  return { root, storage, file: path.join(root, 'settings.json') }
}

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf-8'))

test('a first boot with nothing beside the store writes the defaults, owner-only', async (t) => {
  const h = home(t)
  t.alike(await loadSettings(h.storage), { imported: true, persisted: true, broken: null })
  t.alike(getSettings(), defaultSettings())
  t.alike(read(h.file), defaultSettings(), 'the file is the marker main keys on')
  t.is(fs.statSync(h.file).mode & 0o777, 0o600)
  t.absent(fs.existsSync(h.file + '.tmp'), 'no temp file left behind')
})

test('a first boot imports the moved groups from config.json and leaves it byte-identical', async (t) => {
  const h = home(t)
  const config = JSON.stringify({ version: 1, appearance: { theme: 'dark' }, downloads: { folder: '/tmp/dl' }, network: { downloadKBps: 500, downloadConcurrency: 2 }, backup: { folder: '/tmp/b', repoId: 'r' } })
  fs.writeFileSync(path.join(h.root, 'config.json'), config)
  t.alike(await loadSettings(h.storage), { imported: true, persisted: true, broken: null })
  const s = getSettings()
  t.is(s.downloads.folder, '/tmp/dl')
  t.is(s.network.downloadKBps, 500)
  t.is(s.network.downloadConcurrency, 2)
  t.alike(s.backup, { folder: '/tmp/b', repoId: 'r' })
  t.is(fs.readFileSync(path.join(h.root, 'config.json'), 'utf-8'), config, 'main\'s file is never written by the worker')
  t.alike(read(h.file).downloads, { folder: '/tmp/dl', recent: [] })
})

test('a later boot reads the file and imports nothing', async (t) => {
  const h = home(t)
  await loadSettings(h.storage)
  await updateSettings((s) => { s.network.uploadKBps = 64; return s })
  fs.writeFileSync(path.join(h.root, 'config.json'), JSON.stringify({ network: { uploadKBps: 999 } }))
  _resetSettingsForTests()
  t.alike(await loadSettings(h.storage), { imported: false, persisted: true, broken: null })
  t.is(getSettings().network.uploadKBps, 64, 'the file wins; config.json is not consulted again')
})

test('updateSettings writes first, then publishes; a failed write changes nothing', async (t) => {
  const h = home(t)
  await loadSettings(h.storage)
  const next = await updateSettings((s) => { s.downloads.folder = '/tmp/one'; return s })
  t.is(next.downloads.folder, '/tmp/one')
  t.is(getSettings().downloads.folder, '/tmp/one')
  t.is(read(h.file).downloads.folder, '/tmp/one')

  fs.rmSync(h.file)
  fs.mkdirSync(h.file)
  await t.exception(updateSettings((s) => { s.downloads.folder = '/tmp/two'; return s }), 'the write is refused')
  t.is(getSettings().downloads.folder, '/tmp/one', 'memory still holds the value disk holds')
  fs.rmdirSync(h.file)
})

test('a truncated or hand-broken file loads as defaults for what it lost', async (t) => {
  const h = home(t)
  fs.writeFileSync(h.file, '{"version":1,"network":{"downloadKBps":')
  await loadSettings(h.storage)
  t.alike(getSettings(), defaultSettings(), 'unparseable: defaults')
  _resetSettingsForTests()
  fs.writeFileSync(h.file, JSON.stringify({ version: 1, network: { downloadKBps: 'fast', uploadKBps: 12 }, downloads: 7 }))
  await loadSettings(h.storage)
  t.is(getSettings().network.downloadKBps, 0)
  t.is(getSettings().network.uploadKBps, 12)
  t.is(getSettings().downloads.folder, null)
})

test('a settings.json that exists but cannot be read is never replaced by an import', async (t) => {
  const h = home(t)
  fs.writeFileSync(path.join(h.root, 'config.json'), JSON.stringify({ downloads: { folder: '/tmp/from-config' } }))
  fs.writeFileSync(h.file, '{"version":1,"downloads":{"folder":"/tmp/mine"')
  const before = fs.readFileSync(h.file, 'utf-8')
  const load = await loadSettings(h.storage)
  t.alike({ imported: load.imported, persisted: load.persisted }, { imported: false, persisted: false })
  t.ok(load.broken, 'and says why')
  t.alike(getSettings(), defaultSettings(), 'the worker runs on defaults')
  t.is(fs.readFileSync(h.file, 'utf-8'), before, 'the user\'s file is left for the next write to replace')
  _resetSettingsForTests()
  fs.rmSync(h.file)
  fs.mkdirSync(h.file)
  const dir = await loadSettings(h.storage)
  t.absent(dir.persisted, 'a directory in the way is reported the same way')
  t.ok(dir.broken)
  fs.rmdirSync(h.file)
})

test('bookkeeping never replaces a broken file; the user\'s next change does, and carries it', async (t) => {
  const h = home(t)
  fs.writeFileSync(h.file, '{"version":1,"network":{"uploadKBps":12,}}')
  const before = fs.readFileSync(h.file, 'utf-8')
  await loadSettings(h.storage)
  await updateSettings((s) => { s.downloads.recent = ['/tmp/a']; return s }, { keepBroken: true })
  t.alike(getSettings().downloads.recent, ['/tmp/a'], 'the change is held in memory')
  t.is(fs.readFileSync(h.file, 'utf-8'), before, 'and the user\'s file is left to repair')

  await updateSettings((s) => { s.network.uploadKBps = 64; return s })
  t.alike(read(h.file).downloads.recent, ['/tmp/a'], 'a change the user makes replaces the file, bookkeeping included')
  await updateSettings((s) => { s.downloads.recent = ['/tmp/b', '/tmp/a']; return s }, { keepBroken: true })
  t.alike(read(h.file).downloads.recent, ['/tmp/b', '/tmp/a'], 'and bookkeeping is written through from then on')
})

test('bookkeeping on a sound file is written like any change', async (t) => {
  const h = home(t)
  await loadSettings(h.storage)
  await updateSettings((s) => { s.downloads.recent = ['/tmp/a']; return s }, { keepBroken: true })
  t.alike(read(h.file).downloads.recent, ['/tmp/a'])
})

test('overlapping updates are serialized, so neither change is lost', async (t) => {
  const h = home(t)
  await loadSettings(h.storage)
  const [a, b] = await Promise.all([
    updateSettings((s) => { s.downloads.folder = '/tmp/one'; return s }),
    updateSettings((s) => { s.backup = { folder: '/tmp/b', repoId: 'r' }; return s }),
  ])
  t.is(a.downloads.folder, '/tmp/one')
  t.is(b.downloads.folder, '/tmp/one', 'the second change saw the first')
  t.alike(getSettings().backup, { folder: '/tmp/b', repoId: 'r' })
  t.alike(read(h.file).backup, { folder: '/tmp/b', repoId: 'r' })
  t.is(read(h.file).downloads.folder, '/tmp/one')
})

test('a first boot whose import cannot be written still boots, and says so', async (t) => {
  const h = home(t)
  fs.chmodSync(h.root, 0o500)
  t.teardown(() => fs.chmodSync(h.root, 0o700))
  const load = await loadSettings(h.storage)
  t.alike({ imported: load.imported, persisted: load.persisted }, { imported: true, persisted: false })
  t.alike(getSettings(), defaultSettings())
  t.absent(fs.existsSync(h.file))
})

test('getSettings before loadSettings is a programming error, not a default', (t) => {
  _resetSettingsForTests()
  t.exception(() => getSettings())
})
