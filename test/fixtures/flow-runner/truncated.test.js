// Fixture for test/unit/flow-runner.test.js: a background throw kills the run while a
// registered test is still pending. The runner must fail the run for the tests it never
// reached, not report the ones it managed to finish.
import test from 'brittle'

test('dies mid-run', async (t) => {
  setTimeout(() => { throw new Error('background boom') }, 10)
  await new Promise((resolve) => setTimeout(resolve, 2000))
  t.pass('unreachable')
})

test('never executes', async (t) => { t.pass('second') })
