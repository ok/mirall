// Session-scoped state of the collapsible sidebar cards — Members on SpaceView, People on
// FolderView — keyed by spaceId. Survives leaving and coming back within a session (the screen
// unmounts and remounts); resets on app restart. Deliberately not persisted to config.json — this
// is view state, not a preference.
//
// The People fold is per SPACE, not per folder, because the store is pruned against the live
// SPACE list: a shareId key would look like a dead space and be swept on the next spaces list.
// Per-space is also the better default — collapse People once and every folder in the space
// agrees, rather than asking for the same collapse folder by folder.
import { useCallback, useState } from 'react'

export type SpaceCardKey = 'membersOpen' | 'membersExpanded' | 'folderPeopleOpen'

const DEFAULTS: Record<SpaceCardKey, boolean> = {
  membersOpen: true,
  membersExpanded: false,
  folderPeopleOpen: true,
}

const store = new Map<string, Partial<Record<SpaceCardKey, boolean>>>()

// Left/deleted spaces must not keep their card state cached for the session —
// useSpaces prunes against every fresh spaces list (parity with pruneRosterCache).
export function pruneSpaceCardState(liveSpaceIds: Iterable<string>) {
  const live = new Set(liveSpaceIds)
  for (const spaceId of store.keys()) {
    if (!live.has(spaceId)) store.delete(spaceId)
  }
}

function read(spaceId: string, key: SpaceCardKey): boolean {
  return store.get(spaceId)?.[key] ?? DEFAULTS[key]
}

export function useSpaceCardState(spaceId: string, key: SpaceCardKey): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => read(spaceId, key))

  // Moving between two spaces without leaving the screen (an OS notification click
  // routes straight into another space) swaps the prop on the SAME instance, and a
  // useState initializer never re-runs — without this the space you came from would
  // lend its cards to the one you arrived at. Adjusted during render rather than in an
  // effect, which would paint one frame of the wrong space first.
  const [renderedSpaceId, setRenderedSpaceId] = useState(spaceId)
  if (renderedSpaceId !== spaceId) {
    setRenderedSpaceId(spaceId)
    setValue(read(spaceId, key))
  }

  const commit = useCallback((next: boolean) => {
    store.set(spaceId, { ...store.get(spaceId), [key]: next })
    setValue(next)
  }, [spaceId, key])

  return [value, commit]
}
