import test from 'brittle'
import { PROGRESS_PERSIST_MS, progressPersistDue } from '../../src/shared/transfer/progress-persist.js'
import { TRANSFER_QUIET_MS } from '../../src/shared/transfer/transfer-activity.js'

test('the first progress write is always due', (t) => {
  t.ok(progressPersistDue(0, Date.now()))
})

test('a write is due once the interval has passed since the last one', (t) => {
  const at = 1_000_000
  t.absent(progressPersistDue(at, at + PROGRESS_PERSIST_MS - 1), 'inside the interval')
  t.ok(progressPersistDue(at, at + PROGRESS_PERSIST_MS), 'at the interval')
})

test('a persisted row never goes quiet while its transfer is moving', (t) => {
  t.ok(PROGRESS_PERSIST_MS * 2 < TRANSFER_QUIET_MS, 'two missed writes still land inside the activity window')
})
