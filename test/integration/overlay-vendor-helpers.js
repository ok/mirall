// Ported verbatim from hyper-overlay upstream `test/helpers.js` (6cac8ee), the
// minimal store/dir helpers the vendored chunker/transfer/restart tests use.
// Kept separate from Mirall's `test/helpers/` so the vendored suite stays a
// faithful, re-diffable copy of upstream. NOT a *.test.js — the brittle-bare
// glob skips it.
import fs from 'bare-fs'
import path from 'bare-path'
import os from 'bare-os'
import crypto from 'hypercore-crypto'
import Corestore from 'corestore'

export function mkdtempSync (prefix) {
  const dir = prefix + crypto.randomBytes(6).toString('hex')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function tmpStore (label = 'overlay') {
  return new Corestore(mkdtempSync(path.join(os.tmpdir(), label + '-')))
}

export function tmpDir (label = 'overlay') {
  return mkdtempSync(path.join(os.tmpdir(), label + '-'))
}

export { fs, path, os }
