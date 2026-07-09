import test from 'brittle'
import { isEphemeralSourcePath } from '../../src/shared/folders/temp-paths.js'

// Dragging an unsaved screenshot thumbnail or a Photo Booth capture into the
// drop zone hands us an NSFilePromise materialized into a per-session temp
// location, not a real saved file. Those paths carry distinctive markers; we
// reject them so a share never points at a source that's about to vanish.

test('isEphemeralSourcePath flags macOS promised-file temp locations', (t) => {
  t.ok(isEphemeralSourcePath(
    '/var/folders/3p/abc123/T/TemporaryItems/NSIRD_screencaptureui_xY/Screenshot.png',
  ), 'screenshot thumbnail under TemporaryItems')
  t.ok(isEphemeralSourcePath(
    '/var/folders/3p/abc123/T/TemporaryItems/(A Document Being Saved By Photo Booth)/Photo.jpg',
  ), 'Photo Booth "A Document Being Saved By" wrapper')
  t.ok(isEphemeralSourcePath(
    '/private/var/folders/xx/T/Cleanup At Startup/Untitled.png',
  ), 'Cleanup At Startup scratch location')
})

test('isEphemeralSourcePath is case-insensitive and separator-agnostic', (t) => {
  t.ok(isEphemeralSourcePath('/VAR/FOLDERS/T/temporaryitems/x.png'), 'uppercase marker still matches')
  t.ok(isEphemeralSourcePath('C:\\Users\\me\\AppData\\Local\\Temp\\TemporaryItems\\x.png'), 'backslashes normalized')
})

test('isEphemeralSourcePath accepts genuine saved files', (t) => {
  t.absent(isEphemeralSourcePath('/Users/me/Pictures/Screenshot.png'), 'a saved screenshot in Pictures')
  t.absent(isEphemeralSourcePath('/Users/me/Downloads/photo.jpg'), 'a real download')
  // The test harness creates scratch dirs directly under os.tmpdir(); marker
  // matching (not "anywhere under tmp") keeps those — and any deliberate file
  // in /tmp — sharable.
  t.absent(isEphemeralSourcePath('/var/folders/3p/abc123/T/mirall-test-src-123/a.txt'), 'plain temp scratch dir')
  t.absent(isEphemeralSourcePath('/tmp/report.pdf'), 'a file the user put in /tmp on purpose')
})

test('isEphemeralSourcePath tolerates empty / nullish input', (t) => {
  t.absent(isEphemeralSourcePath(''))
  t.absent(isEphemeralSourcePath(null))
  t.absent(isEphemeralSourcePath(undefined))
})
