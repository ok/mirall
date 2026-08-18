// Mirrors RETENTION_CHOICES in src/shared/audit/audit-retention.js — the renderer cannot import
// worker data-layer code. Only the offered presets live here; the worker validates whatever it
// receives, so a divergence degrades the picker, never the stored value.
export const RETENTION_CHOICES: number[] = [30, 90, 365]
