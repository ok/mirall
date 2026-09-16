export type FolderRouteState = 'hold' | 'show' | 'missing'

export function folderRouteState(state: { found: boolean; loading: boolean }): FolderRouteState
