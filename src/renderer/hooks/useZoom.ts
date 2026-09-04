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

const EPSILON = 0.005

export function isSameZoom(a: number, b: number): boolean {
  return Math.abs(a - b) < EPSILON
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
