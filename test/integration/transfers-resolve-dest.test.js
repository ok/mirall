import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { nameTakenAt, resolveDest } from '../../src/shared/transfer/download-dest.js'
import { tmpDir } from '../helpers/bare-tmp.js'

// FIX-3 — the destination picker is the core data-loss guard for downloads: it
// must never return a path that would overwrite a pre-existing file or collide
// with an in-flight `.partial` or `.mirall.part`. Walk: "name.ext" → "name (1).ext" → …
// This unit suite is the collision guard; resolveDest is exercised directly here.

test('an empty directory yields the plain name', (t) => {
  const dir = tmpDir('rd', t)
  t.is(resolveDest(dir, 'report.txt'), path.join(dir, 'report.txt'))
})

test('a pre-existing file is never overwritten — picks "(1)"', (t) => {
  const dir = tmpDir('rd', t)
  fs.writeFileSync(path.join(dir, 'report.txt'), 'the user’s own file')
  t.is(resolveDest(dir, 'report.txt'), path.join(dir, 'report (1).txt'))
})

test('successive collisions increment the suffix', (t) => {
  const dir = tmpDir('rd', t)
  fs.writeFileSync(path.join(dir, 'report.txt'), 'x')
  fs.writeFileSync(path.join(dir, 'report (1).txt'), 'x')
  t.is(resolveDest(dir, 'report.txt'), path.join(dir, 'report (2).txt'))
})

test('#8: an in-flight partial also blocks a candidate (no two downloads collide)', (t) => {
  const dir = tmpDir('rd', t)
  fs.writeFileSync(path.join(dir, 'report.txt.mirall.part'), 'half a download')
  t.is(resolveDest(dir, 'report.txt'), path.join(dir, 'report (1).txt'),
    'an in-flight partial is treated as taken — a fresh download never adopts an orphan')
})

// The probe keys on OUR suffix only. A stranger's in-progress download is not a
// destination collision: we would still write `report.txt`, which does not exist.
test("another app's in-progress download does not block a candidate", (t) => {
  const dir = tmpDir('rd', t)
  fs.writeFileSync(path.join(dir, 'report.txt.part'), 'firefox is busy')
  t.is(resolveDest(dir, 'report.txt'), path.join(dir, 'report.txt'),
    'a foreign .part is not a collision on the final name')
})

test('extension-less names get the suffix before nothing', (t) => {
  const dir = tmpDir('rd', t)
  fs.writeFileSync(path.join(dir, 'LICENSE'), 'x')
  t.is(resolveDest(dir, 'LICENSE'), path.join(dir, 'LICENSE (1)'))
})

test('dotted names treat only the last segment as the extension', (t) => {
  const dir = tmpDir('rd', t)
  fs.writeFileSync(path.join(dir, 'archive.tar.gz'), 'x')
  t.is(resolveDest(dir, 'archive.tar.gz'), path.join(dir, 'archive.tar (1).gz'))
})

test('nameTakenAt sees a final file or its in-flight partial as taken', (t) => {
  const dir = tmpDir('rd', t)
  const abs = path.join(dir, 'a.txt')
  t.absent(nameTakenAt(abs), 'nothing there → free')
  fs.writeFileSync(abs + '.mirall.part', 'half')
  t.ok(nameTakenAt(abs), 'a partial alone takes the name')
  fs.rmSync(abs + '.mirall.part')
  fs.writeFileSync(abs, 'whole')
  t.ok(nameTakenAt(abs), 'a final file takes the name')
})
