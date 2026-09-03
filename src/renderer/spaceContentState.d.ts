export interface SpacePaneState {
  filesLoading: boolean
  sharesLoading: boolean
  filesError: Error | null
  fileCount: number
  shareCount: number
}

export function showSpaceEmptyState(state: SpacePaneState): boolean
export function showSpaceLoading(state: SpacePaneState): boolean
