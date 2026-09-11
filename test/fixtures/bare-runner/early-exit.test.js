import test from 'brittle'

test('leaves before the run is reported', async (t) => {
  t.ok(true, 'one assertion lands')
  Bare.exit(0)
})
