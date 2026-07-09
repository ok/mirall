import test from 'brittle'
import { formatSize } from '../../src/renderer/formatSize.js'

// The renderer divided byte counts by 1024 (binary) but labeled the result with
// decimal units (KB/MB/GB/TB). macOS Finder and GNOME Files both use decimal
// (1 GB = 1000^3 bytes), so a file the OS reports as 629.68 GB rendered in-app as
// "586.4 GB" — the same byte count, a binary divisor wearing a decimal label.
// The fix divides by 1000 so our number matches the operating system.

test('REGRESSION (FIX-SIZE-1): decimal units make the in-app size match the OS', (t) => {
  // The exact bug report: Finder showed 629.68 GB; the app showed 586.4 GB.
  // 629.68 GB decimal == 629.68e9 bytes; the old 1024^3 divisor yielded 586.4.
  const bytes = 629_680_000_000
  t.is(formatSize(bytes, 'en-US'), '629.7 GB', 'matches the OS decimal size, not the old 586.4')

  // The old binary divisor would have produced this — lock it out.
  t.not(formatSize(bytes, 'en-US'), '586.4 GB', 'no longer the binary-divisor value')
})

test('FIX-SIZE-2: unit boundaries fall on powers of 1000, not 1024', (t) => {
  t.is(formatSize(1000, 'en-US'), '1 KB', '1000 bytes is exactly 1 KB')
  t.is(formatSize(999, 'en-US'), '999 B', 'just under 1 KB stays in bytes')
  t.is(formatSize(1_000_000, 'en-US'), '1 MB')
  t.is(formatSize(1_500_000, 'en-US'), '1.5 MB')
  t.is(formatSize(1_000_000_000, 'en-US'), '1 GB')
  t.is(formatSize(1_000_000_000_000, 'en-US'), '1 TB')
  // 1024 bytes is no longer "1 KB" — it's 1.0 KB under decimal scaling.
  t.is(formatSize(1024, 'en-US'), '1 KB', '1024 bytes rounds to 1.0 -> "1 KB"')
})

test('FIX-SIZE-3: precision — bytes/KB show no decimals, MB and up show one', (t) => {
  t.is(formatSize(512, 'en-US'), '512 B', 'bytes: no fraction')
  t.is(formatSize(1500, 'en-US'), '1.5 KB', 'KB: one fraction digit')
  t.is(formatSize(2_340_000, 'en-US'), '2.3 MB', 'MB rounds to one digit')
})

test('FIX-SIZE-4: number formatting is locale-aware', (t) => {
  // German uses a comma decimal separator — this is what the Finder screenshot
  // ("629,68 GB") shows, and what the localized app must mirror.
  t.is(formatSize(1_500_000_000, 'de-DE'), '1,5 GB', 'de-DE uses a comma separator')
  t.is(formatSize(1_500_000_000, 'en-US'), '1.5 GB', 'en-US uses a period separator')
})

test('FIX-SIZE-5: zero / falsy / negative inputs return "0 B"', (t) => {
  t.is(formatSize(0, 'en-US'), '0 B')
  t.is(formatSize(undefined, 'en-US'), '0 B')
  t.is(formatSize(null, 'en-US'), '0 B')
  t.is(formatSize(NaN, 'en-US'), '0 B')
  t.is(formatSize(-100, 'en-US'), '0 B', 'negative byte counts cannot happen but never produce garbage')
})

test('FIX-SIZE-6: files beyond the largest unit clamp to TB instead of "undefined"', (t) => {
  // 2 PB == 2000 TB. The old code indexed past the units array and rendered
  // "undefined"; the clamp keeps it numeric.
  t.is(formatSize(2_000_000_000_000_000, 'en-US'), '2,000 TB', 'petabyte-scale clamps to TB')
})
