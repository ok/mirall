import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, assert } from '../assert.mjs'
import { spawnHeadless, connectClient } from '../../helpers/headless.js'

// A profile whose back end was started on its own, before the app: the app uses that back end
// rather than a second one, hands it the key, and works through it; quitting the app leaves it
// running, because the app did not start it.
export default async function s200({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Attached', bootstrap, slot: 0, total: 1 })
  const args = ['--storage', A.store, '--dev', '--runtime-config', JSON.stringify({ downloadFolder: A.downloadFolder })]
  if (bootstrap) args.push('--dht-bootstrap', bootstrap.map((node) => `${node.host}:${node.port}`).join(','))
  const backend = spawnHeadless(args)

  try {
    let socket = null
    await r.ok('a back end started on its own waits on the profile', async () => {
      socket = await backend.listening(30000)
    })

    await r.ok('the app opens onto it and reaches the spaces list', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      assert(backend.child.exitCode === null, 'the back end the app found is the one serving it')
      await A.shot('s200-attached', runDir)
    })

    await r.ok('quitting the app leaves that back end running, with what the app did in it', async () => {
      await A.quit()
      assert(backend.child.exitCode === null, 'it was not stopped')
      const client = connectClient(socket)
      try {
        const status = await client.call('identity:status')
        assert(status.data?.locked === false, `its identity stays open (${JSON.stringify(status.data)})`)
        const spaces = await client.call('spaces:list')
        assert(Array.isArray(spaces.data) && spaces.data.some((s) => s.name === 'Aurora'), 'and it still holds the space')
      } finally {
        client.close()
      }
    })
  } catch {}

  backend.child.kill('SIGTERM')
  await Promise.race([backend.exited, new Promise((resolve) => setTimeout(resolve, 10000))])
  return { pass: r.summary(), instances: [A] }
}
