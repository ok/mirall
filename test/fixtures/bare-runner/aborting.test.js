import test from 'brittle'

// The family the process-per-file runner exists for: a rejection nobody awaits, which Bare turns
// into an abort with no tap summary and no test name.
test('abandons a rejecting promise', async (t) => {
  Promise.reject(new Error('nothing awaits this'))
  t.ok(true, 'the test body itself is fine')
})
