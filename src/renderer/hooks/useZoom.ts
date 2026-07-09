// UI zoom presets plus a hook syncing the persisted zoom factor with main (getZoom/onZoomChanged/setZoom).
import { useEffect, useState } from 'react'

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
  const [zoom, setZoomState] = useState(1.0)

  useEffect(() => {
    let cancelled = false
    window.bridge.getZoom().then((factor) => {
      if (!cancelled) setZoomState(factor)
    })
    const unsub = window.bridge.onZoomChanged((factor) => {
      if (!cancelled) setZoomState(factor)
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  async function setZoom(factor: number): Promise<void> {
    const applied = await window.bridge.setZoom(factor)
    setZoomState(applied)
  }

  return { zoom, setZoom }
}
