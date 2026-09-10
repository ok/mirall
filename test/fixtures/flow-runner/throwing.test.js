// Fixture for test/unit/flow-runner.test.js: a test body that throws the way a
// timed-out `until()` does. The runner must name it in a `not ok` and still run
// the test that follows it.
import test from 'brittle'

test('runs before the throw', async (t) => { t.pass('first') })

test('throws like a timed-out until', async (t) => {
  await new Promise((resolve) => setTimeout(resolve, 10))
  throw new Error('until() timed out on audit:list after 20000ms (Alice)')
})

test('runs after the throw', async (t) => { t.pass('third') })
