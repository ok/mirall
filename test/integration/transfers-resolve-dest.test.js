import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { resolveDest } from '../../src/shared/transfer/download-dest.js'

function tmpDir (t) {
  const d = path.join(os.tmpdir(), 'rd-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))
  fs.mkdirSync(d, { recursive: true })
  if (t) t.teardown(() => { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} })
  return d
}

// FIX-3 — the destination picker is the core data-loss guard for downloads: it
// must never return a path that would overwrite a pre-existing file or collide
// with an in-flight `.partial` or `.overlay-partial`. Walk: "name.ext" → "name (1).ext" → …
// This unit suite is the collision guard; resolveDest is exercised directly here.

test('an empty directory yields the plain name', (t) => {
  const dir = tmpDir(t)
  t.is(resolveDest(dir, 'report.txt'), path.join(dir, 'report.txt'))
})

test('a pre-existing file is never overwritten — picks "(1)"', (t) => {
  const dir = tmpDir(t)
  fs.writeFileSync(path.join(dir, 'report.txt'), 'the user’s own file')
  t.is(resolveDest(dir, 'report.txt'), path.join(dir, 'report (1).txt'))
})

test('successive collisions increment the suffix', (t) => {
  const dir = tmpDir(t)
  fs.writeFileSync(path.join(dir, 'report.txt'), 'x')
  fs.writeFileSync(path.join(dir, 'report (1).txt'), 'x')
  t.is(resolveDest(dir, 'report.txt'), path.join(dir, 'report (2).txt'))
})

test('an in-flight .partial also blocks a candidate (no two downloads collide)', (t) => {
  const dir = tmpDir(t)
  fs.writeFileSync(path.join(dir, 'report.txt.partial'), 'half a download')
  t.is(resolveDest(dir, 'report.txt'), path.join(dir, 'report (1).txt'),
    'the .partial of another in-flight download is treated as taken')
})

test('#8: an in-flight .overlay-partial also blocks a candidate', (t) => {
  const dir = tmpDir(t)
  fs.writeFileSync(path.join(dir, 'report.txt.overlay-partial'), 'half an overlay download')
  t.is(resolveDest(dir, 'report.txt'), path.join(dir, 'report (1).txt'),
    'an overlay engine partial is treated as taken — a fresh download never adopts an orphan')
})

test('extension-less names get the suffix before nothing', (t) => {
  const dir = tmpDir(t)
  fs.writeFileSync(path.join(dir, 'LICENSE'), 'x')
  t.is(resolveDest(dir, 'LICENSE'), path.join(dir, 'LICENSE (1)'))
})

test('dotted names treat only the last segment as the extension', (t) => {
  const dir = tmpDir(t)
  fs.writeFileSync(path.join(dir, 'archive.tar.gz'), 'x')
  t.is(resolveDest(dir, 'archive.tar.gz'), path.join(dir, 'archive.tar (1).gz'))
})
