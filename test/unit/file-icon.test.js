import test from 'brittle'
import { getFileIcon } from '../../src/renderer/fileIcon.js'

// The folder views (browse / on-demand / eager / mirrored) used to hard-code the
// generic "description" icon for every file row, while the space view derived a
// content-type icon via getFileIcon. The fix routes the folder views through the
// same mapping. These tests lock the extension → icon contract both views rely on
// so the two can never drift again.

test('REGRESSION (FIX-ICON-1): content-type extensions map to type-specific icons, not the generic document', (t) => {
  // The two types the bug report called out explicitly: images and archives.
  t.is(getFileIcon('vacation.png'), 'image', 'image gets the image icon, not "description"')
  t.is(getFileIcon('photo.JPG'), 'image', 'extension match is case-insensitive')
  t.is(getFileIcon('backup.zip'), 'folder_zip', 'archive gets the archive icon, not "description"')
  t.is(getFileIcon('logs.tar'), 'folder_zip')

  // Spot-check the other content families so the whole map stays wired.
  t.is(getFileIcon('report.pdf'), 'picture_as_pdf')
  t.is(getFileIcon('budget.xlsx'), 'table_chart')
  t.is(getFileIcon('clip.mp4'), 'movie')
  t.is(getFileIcon('song.flac'), 'music_note')
  t.is(getFileIcon('main.ts'), 'code')
  t.is(getFileIcon('config.yaml'), 'data_object')
  t.is(getFileIcon('notes.md'), 'article')

  // A genuine document extension does still resolve to "description" — proving the
  // old behavior wasn't "always correct for .doc", it was wrong for everything else.
  t.is(getFileIcon('letter.docx'), 'description')
})

test('getFileIcon resolves by the last extension of a nested relative path', (t) => {
  // Folder-view rows carry relPaths like "photos/a.jpg"; only the final extension matters.
  t.is(getFileIcon('photos/a.jpg'), 'image')
  t.is(getFileIcon('a/b/c/archive.7z'), 'folder_zip')
  t.is(getFileIcon('my.backup.dir/clip.webm'), 'movie', 'dots in directory names do not confuse the lookup')
})

test('getFileIcon falls back to the generic draft icon for unknown or extensionless files', (t) => {
  t.is(getFileIcon('README'), 'draft', 'no extension → generic fallback')
  t.is(getFileIcon('archive/data'), 'draft', 'extensionless nested file → generic fallback')
  t.is(getFileIcon('mystery.xyz'), 'draft', 'unknown extension → generic fallback')
  t.is(getFileIcon(''), 'draft', 'empty path → generic fallback')
  t.is(getFileIcon('.gitignore'), 'draft', 'dotfile with no real extension → generic fallback')
})
