// What the folder route does with a share it looked up in the live listing. A share's role is a
// three-source answer (share:list, foreign-folder:list-all, owned-folder:list-all): with the share
// alone, a mirrored folder reads as browse and offers per-file download controls until the mount
// listing lands. Absence is only "gone" once every read has settled.
/** @typedef {'hold' | 'show' | 'missing'} FolderRouteState */

/** @param {{ found: boolean, loading: boolean }} state @returns {FolderRouteState} */
export function folderRouteState({ found, loading }) {
  if (loading) return 'hold'
  return found ? 'show' : 'missing'
}
