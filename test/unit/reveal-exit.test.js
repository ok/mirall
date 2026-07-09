import test from 'brittle'
import { revealExitIsFailure } from '../../src/shared/transfer/reveal-exit.js'

test('revealExitIsFailure: explorer.exe exit-1 on win32 is a benign success, not a failure', (t) => {
  t.absent(revealExitIsFailure('win32', 0), 'win32 code 0 is success')
  t.absent(revealExitIsFailure('win32', 1), 'win32 code 1 is the explorer.exe quirk — not a failure')
  t.ok(revealExitIsFailure('win32', 2), 'win32 code 2 is a real failure')

  t.absent(revealExitIsFailure('darwin', 0), 'darwin code 0 is success')
  t.ok(revealExitIsFailure('darwin', 1), 'darwin code 1 (open) is a real failure')

  t.absent(revealExitIsFailure('linux', 0), 'linux code 0 is success')
  t.ok(revealExitIsFailure('linux', 1), 'linux code 1 (xdg-open) is a real failure')
})
