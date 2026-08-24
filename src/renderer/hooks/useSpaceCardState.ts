// Session-scoped state of the SpaceView sidebar cards (Space Storage, Members), keyed
// by spaceId. Survives leaving a space and coming back within a session (SpaceView
// unmounts and remounts); resets on app restart. Deliberately not persisted to
// config.json — this is per-space view state, not a preference.
import { useCallback, useState } from 'react'

export type SpaceCardKey = 'storageOpen' | 'membersOpen' | 'membersExpanded'

const DEFAULTS: Record<SpaceCardKey, boolean> = {
  storageOpen: true,
  membersOpen: true,
  membersExpanded: false,
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
