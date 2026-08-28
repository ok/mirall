import fs from 'bare-fs'
import path from 'bare-path'

// Is a file present under EXACTLY this name? A following stat says "yes" for a file that only
// changed case (APFS and NTFS fold), changed Unicode normalization, or was replaced by a symlink
// — but the diff that decides a retire compares exact readdir names, and a retire confirmed
// against a weaker test than the one that proposed it never runs: the folded name stays
// advertised to every peer forever. Stat first, so a genuinely missing file costs no readdir.
export function fileExactlyPresent(absPath) {
  try {
    if (!fs.statSync(absPath).isFile()) return false
  } catch {
    return false
  }
  const name = path.basename(absPath)
  let entries
  try {
    entries = fs.readdirSync(path.dirname(absPath), { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) if (entry.name === name) return entry.isFile()
  return false
}

// Presence as the app will OPEN the path — a following stat. For a file whose identity is its
// recorded absolute path (a loose share), a case-only rename on a folding volume or a symlinked
// source keeps it readable, so it stays shared.
export function fileStatPresent(absPath) {
  try {
    return fs.statSync(absPath).isFile()
  } catch {
    return false
  }
}

// The enqueue-time facts of a path: size feeds the ordering, size+mtime the fold/supersede test.
export function statFacts(absPath) {
  try {
    const st = fs.statSync(absPath)
    return { size: st.size, mtime: st.mtimeMs }
  } catch {
    return { size: 0, mtime: 0 }
  }
}
