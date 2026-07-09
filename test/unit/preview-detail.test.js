import test from 'brittle'
import { PREVIEW_DETAIL_MAX_FILES, includePerFile } from '../../src/shared/folders/preview-detail.js'

test('includePerFile: at or below the cap shows the detailed list', (t) => {
  t.is(PREVIEW_DETAIL_MAX_FILES, 50)
  t.ok(includePerFile(0))
  t.ok(includePerFile(1))
  t.ok(includePerFile(PREVIEW_DETAIL_MAX_FILES))
})

test('includePerFile: above the cap omits the list', (t) => {
  t.absent(includePerFile(PREVIEW_DETAIL_MAX_FILES + 1))
  t.absent(includePerFile(1000))
})
