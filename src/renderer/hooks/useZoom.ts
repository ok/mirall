// UI zoom presets plus a hook reading the persisted zoom factor from the main store.
import { useCallback } from 'react'
import { useMainQuery } from '../store/useMainQuery.js'

export interface ZoomLevel {
  key: 'compact' | 'cozy' | 'default' | 'spacious'
  factor: number
  labelKey: string
}

export const ZOOM_LEVELS: readonly ZoomLevel[] = [
  { key: 'compact', factor: 0.85, labelKey: 'appearanceSettings.zoomCompact' },
  { key: 'cozy', factor: 0.92, labelKey: 'appearanceSettings.zoomCozy' },
  { key: 'default', factor: 1.0, labelKey: 'appearanceSettings.zoomDefault' },
  { key: 'spacious', factor: 1.10, labelKey: 'appearanceSettings.zoomSpacious' },
]

// The presets are four named rungs, but the factor itself is continuous: main steps it by 0.05
// within a 0.5-1.5 clamp, so most values sit between two rungs. Any factor resolves to the closest
// one — past either end, to that end — so the Zoom control always marks exactly one preset. A
// factor exactly between two rungs takes the lower one, so the answer never depends on how the
// ladder is walked.
export function nearestZoomLevel(factor: number): ZoomLevel {
  let nearest = ZOOM_LEVELS[0]
  for (const level of ZOOM_LEVELS) {
    if (Math.abs(factor - level.factor) < Math.abs(factor - nearest.factor)) nearest = level
  }
  return nearest
}

export function useZoom(): { zoom: number; setZoom: (factor: number) => Promise<void> } {
  // The store carries main's onZoomChanged push, so a factor changed from the menu or a shortcut
  // lands here without this hook holding a subscription of its own.
  const { data, write } = useMainQuery('main:zoom')
  // 1.0 is the app's zoom identity and the factor is applied to the window by main, so a
  // pre-settle render at 1.0 is correct rather than a placeholder.
  const zoom = data ?? 1.0
  const setZoom = useCallback(async (factor: number) => { await write(factor) }, [write])
  return { zoom, setZoom }
}
