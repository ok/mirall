// Crash-safe file write: write + fsync a sibling `.tmp`, then rename over the target and fsync the
// directory, so a reader (or a crash mid-write, or a power loss after it) sees either the old or the
// new content — never a torn file, and never the old one once this resolved.
export async function writeFileAtomic(file, data, mode = 0o600) {
  const fs = (await import('bare-fs')).default
  const path = (await import('bare-path')).default
  const tmp = file + '.tmp'
  const fd = fs.openSync(tmp, 'w', mode)
  try {
    fs.writeSync(fd, data)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
  syncDirectory(fs, path.dirname(file))
}

// A platform that cannot open a directory (Windows) keeps the rename's own durability.
function syncDirectory(fs, dir) {
  let fd
  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
  } catch {
    return
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}
