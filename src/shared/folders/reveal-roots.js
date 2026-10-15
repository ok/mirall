// Every disk root the client may show a reveal under: the download folders and every mount path.
// Main authorizes "reveal in folder" against this set and cannot read the space or mount records
// that hold it, so the worker computes it here and pushes it on every change.
import { listDownloadRoots } from '../core/paths.js'
import { listAllMounts } from './mount-store.js'

export async function listRevealRoots() {
  const mounts = await listAllMounts()
  return [...new Set([...listDownloadRoots(), ...mounts.map((m) => m.mountPath)])]
}
