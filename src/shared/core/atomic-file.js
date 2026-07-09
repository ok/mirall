// Crash-safe file write: write + fsync a sibling `.tmp`, then rename over the target,
// so a reader (or a crash mid-write) sees either the old or the new content — never
// a torn file.
export async function writeFileAtomic (file, data, mode = 0o600) {
  const fs = (await import('bare-fs')).default
  const tmp = file + '.tmp'
  const fd = fs.openSync(tmp, 'w', mode)
  try {
    fs.writeSync(fd, data)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
}
