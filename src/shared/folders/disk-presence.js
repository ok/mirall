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
