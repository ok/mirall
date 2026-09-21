import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { transferFaultToast } from '../../src/renderer/model/transfer-fault-toast.js'
import { CODES } from '../../src/shared/contract/errors.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const LOCALES_DIR = path.resolve(here, '../../src/renderer/locales')
const locales = fs.readdirSync(LOCALES_DIR).filter((d) => fs.statSync(path.join(LOCALES_DIR, d)).isDirectory())
const common = (locale) => JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, 'common.json'), 'utf8'))

test('a terminal fault toast is keyed per space and fault, not per file', (t) => {
  const a = transferFaultToast('s1', CODES.TRANSFER_DISK_FULL)
  t.is(a.id, 'disk-full:s1')
  t.alike(transferFaultToast('s1', CODES.TRANSFER_DISK_FULL), a, 'a second file replaces the same toast')
  t.is(transferFaultToast('s2', CODES.TRANSFER_DISK_FULL).id, 'disk-full:s2')
  t.is(transferFaultToast('s1', CODES.TRANSFER_CHECKSUM).id, 'checksum:s1')
  t.is(transferFaultToast('s1', CODES.TRANSFER_PERMISSION), null)
  t.is(transferFaultToast('s1', undefined), null)
})

test('the replacing toast copy names no file in any locale', (t) => {
  for (const locale of locales) {
    const file = common(locale).file
    for (const code of [CODES.TRANSFER_DISK_FULL, CODES.TRANSFER_CHECKSUM]) {
      const key = transferFaultToast('s1', code).key.replace(/^file\./, '')
      const str = file?.[key]
      t.ok(typeof str === 'string' && str.length > 0, `${locale}: ${key} present`)
      t.absent(str.includes('{{'), `${locale}: ${key} interpolates nothing`)
    }
  }
})

test('the coalesced notification body counts files in every locale', (t) => {
  for (const locale of locales) {
    const notifications = common(locale).notifications
    for (const key of ['transferErrorManyBody_one', 'transferErrorManyBody_other']) {
      const str = notifications?.[key]
      t.ok(typeof str === 'string' && str.includes('{{count}}') && str.includes('{{reason}}'), `${locale}: ${key}`)
    }
  }
})
