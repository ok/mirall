// Human-readable byte formatting, kept in a pure, dependency-free module so the
// brittle-node suite can unit-test the unit-scaling math without pulling in i18n.
// utils.ts wraps this and supplies i18n.language as the locale.
//
// Decimal (SI) units: 1 KB = 1000 bytes. This matches what the operating system
// shows — macOS Finder, GNOME Files/Nautilus, iOS/Android, and storage-device
// labeling all use decimal — so the size Mirall displays always agrees with the
// size the OS shows for the same file. The divisor must match the labels: a
// binary 1024 divisor under decimal KB/MB/GB/TB labels would read ~7-10% below
// the OS at large sizes (e.g. a 629.68 GB file shown as "586.4 GB").
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']
const STEP = 1000

export function formatSize(bytes, locale) {
  if (!bytes || bytes <= 0) return '0 B'
  // Clamp the unit index so files beyond the largest unit (>= 1000 TB) still
  // render a number rather than "undefined".
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(STEP)), UNITS.length - 1)
  const value = bytes / Math.pow(STEP, i)
  const formatted = new Intl.NumberFormat(locale, {
    maximumFractionDigits: i > 0 ? 1 : 0,
    minimumFractionDigits: 0,
  }).format(value)
  return `${formatted} ${UNITS[i]}`
}
