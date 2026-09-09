import test from 'brittle'
import { shortfall, FREE_SPACE_HEADROOM } from '../../src/shared/transfer/free-space.js'

const MB = 1024 * 1024

test('a volume that fits the file plus headroom reports no shortfall', (t) => {
  t.is(shortfall({ freeBytes: 500 * MB, needBytes: 100 * MB }), 0)
  t.is(shortfall({ freeBytes: 100 * MB + FREE_SPACE_HEADROOM, needBytes: 100 * MB }), 0, 'exactly enough')
})

test('the shortfall is what is missing, not a boolean', (t) => {
  t.is(shortfall({ freeBytes: 100 * MB, needBytes: 100 * MB }), FREE_SPACE_HEADROOM,
    'a file that fits byte-for-byte still owes the headroom')
  t.is(shortfall({ freeBytes: 0, needBytes: 10 }), 10 + FREE_SPACE_HEADROOM)
})

// A resumed partial has already taken its bytes from the volume; charging for them twice would
// refuse a transfer that is most of the way done.
test('bytes a partial already allocated are not charged again', (t) => {
  t.is(shortfall({ freeBytes: FREE_SPACE_HEADROOM, needBytes: 100 * MB, allocatedBytes: 100 * MB }), 0)
  t.is(shortfall({ freeBytes: FREE_SPACE_HEADROOM, needBytes: 100 * MB, allocatedBytes: 40 * MB }), 60 * MB)
  t.is(shortfall({ freeBytes: 999 * MB, needBytes: 10, allocatedBytes: 9999 }), 0,
    'over-allocation never becomes a negative requirement')
})

// The direction that matters: an unmeasurable volume must not block a transfer. statfs fails on some
// network mounts, and refusing to sync because we could not measure is worse than trying.
test('an unmeasurable volume fails open', (t) => {
  t.is(shortfall({ freeBytes: Infinity, needBytes: 1e12 }), 0, 'the probe’s fail-open value')
  t.is(shortfall({ freeBytes: NaN, needBytes: 1e12 }), 0)
  t.is(shortfall({ freeBytes: undefined, needBytes: 1e12 }), 0)
})

test('the headroom is overridable but defaults to 64 MiB', (t) => {
  t.is(FREE_SPACE_HEADROOM, 64 * MB)
  t.is(shortfall({ freeBytes: 10, needBytes: 0, headroom: 0 }), 0)
  t.is(shortfall({ freeBytes: 0, needBytes: 0, headroom: 5 }), 5)
})
