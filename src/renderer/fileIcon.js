// Pure, dependency-free extension → icon mapping. Kept as plain JS (no i18n /
// browser imports) so it is the single source of truth shared by the sandboxed
// renderer bundle (esbuild/tsc) and the brittle-node unit suite — the same
// pattern as sharePaths.js. Both the space view (FileCard) and the folder views
// (FolderView) must derive a file's icon from here so content types render
// consistently across the app.

/**
 * @typedef {import('./components/primitives/Icon.js').IconName} IconName
 */

/** @type {Record<string, IconName>} */
const iconMap = {
  pdf: 'picture_as_pdf',
  doc: 'description', docx: 'description',
  xls: 'table_chart', xlsx: 'table_chart', csv: 'table_chart',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image',
  mp4: 'movie', mov: 'movie', avi: 'movie', mkv: 'movie', webm: 'movie',
  mp3: 'music_note', wav: 'music_note', flac: 'music_note', aac: 'music_note',
  zip: 'folder_zip', rar: 'folder_zip', '7z': 'folder_zip', tar: 'folder_zip', gz: 'folder_zip',
  js: 'code', jsx: 'code', ts: 'code', tsx: 'code', py: 'code', rs: 'code', go: 'code',
  json: 'data_object', xml: 'data_object', yaml: 'data_object', yml: 'data_object',
  md: 'article', txt: 'article',
}

/**
 * Icon for a file, derived from its lowercased extension. Tolerant of nested
 * relative paths ("photos/a.jpg") and of files with no extension, which fall
 * back to the generic document icon.
 * @param {string} filePath
 * @returns {IconName}
 */
export function getFileIcon(filePath) {
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  return iconMap[ext] || 'draft'
}
