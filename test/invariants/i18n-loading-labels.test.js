import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const LOCALES_DIR = path.resolve(here, '../../src/renderer/locales')

// The file-listing loading copy renders an animated trailing ellipsis (LoadingFiles
// + .loading-dots). The label string itself must therefore carry NO trailing dots,
// otherwise the UI doubles up ("Lade Dateien…...").
const LOADING_LABELS = [
  ['space', 'loadingFiles'],
  ['folder', 'loading'],
]

const locales = fs.readdirSync(LOCALES_DIR).filter((d) => fs.statSync(path.join(LOCALES_DIR, d)).isDirectory())

for (const loc of locales) {
  test(`i18n: ${loc} loading labels carry no trailing ellipsis`, (t) => {
    const common = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, loc, 'common.json'), 'utf8'))
    for (const [ns, key] of LOADING_LABELS) {
      const value = common[ns]?.[key]
      t.ok(typeof value === 'string' && value.length > 0, `${loc} ${ns}.${key} is a non-empty string`)
      t.absent(/[.…]\s*$/.test(value), `${loc} ${ns}.${key} ("${value}") has no trailing dot/ellipsis`)
    }
  })
}
