import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { pausedBodyKey } from '../../src/renderer/notifications/pausedToast.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const LOCALES_DIR = path.resolve(here, '../../src/renderer/locales')

// The paused toast blames the sender's absence only when they are actually offline; an
// 'interrupted' pause (owner online — content evicted/re-indexing/holder churn) uses a distinct
// body. Pins the reason->key mapping the FIX-EDA-20 flow test asserts only at the wire layer.
test('pausedBodyKey maps the transfer-paused reason to the right body key', (t) => {
  t.is(pausedBodyKey('interrupted'), 'notifications.transferPausedInterruptedBody')
  t.is(pausedBodyKey('offline'), 'notifications.transferPausedBody')
  t.is(pausedBodyKey(undefined), 'notifications.transferPausedBody', 'a legacy frame with no reason reads as offline')
})

test('both paused-toast body keys resolve in every locale (with the file interpolation)', (t) => {
  const locales = fs.readdirSync(LOCALES_DIR).filter((d) => fs.statSync(path.join(LOCALES_DIR, d)).isDirectory())
  for (const locale of locales) {
    const notifications = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, 'common.json'), 'utf8')).notifications
    for (const key of ['transferPausedBody', 'transferPausedInterruptedBody']) {
      const str = notifications?.[key]
      t.ok(typeof str === 'string' && str.length > 0, `${locale}: ${key} present`)
      t.ok(str.includes('{{file}}'), `${locale}: ${key} interpolates {{file}}`)
    }
  }
})
