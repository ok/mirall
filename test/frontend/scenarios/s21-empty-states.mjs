import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, assert } from '../assert.mjs'

// Empty states: a fresh profile shows the no-spaces and no-favorites copy, a freshly
// created space shows the empty-share copy, and both carry a docs card linking out to
// mirall.app. Selectors match on `contains`, not `name`: the sr-only "Opens mirall.app in
// your browser" span is part of each link's accessible name on purpose. The role assertion
// is the a11y guarantee — these must stay anchors, not buttons wired to an onClick.
export default async function s21 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  try {
    await r.ok('a fresh profile has no spaces', async () => {
      await A.launch()
      await A.waitText('No spaces yet', 8000)
      await A.shot('s21-no-spaces', runDir)
    })
    await r.ok('the no-spaces state offers the docs card', async () => {
      await A.waitText('New to Mirall?', 8000)
      assert(await A.has({ role: 'link', contains: 'Send your first files' }), 'tutorial link present')
      assert(await A.has({ role: 'link', contains: 'Create a space' }), 'create-a-space link present')
      assert(await A.has({ role: 'link', contains: 'Join a space with an invite' }), 'join-a-space link present')
      assert(await A.hasText('Opens mirall.app in your browser'), 'the destination is in the accessible name')
      await A.shot('s21-no-spaces-docs', runDir)
    })
    await r.ok('the Favorites tab is empty and carries no docs card', async () => {
      await A.click({ name: 'Favorites' })
      await A.waitText('No favorites yet', 8000)
      assert(!(await A.hasText('New to Mirall?')), 'the favorites empty state stays bare')
      await A.click({ name: 'All Spaces' })
    })
    await r.ok('a new space shows the empty-share copy', async () => {
      await A.createSpaceOnly('Aurora')
      await A.waitText('Nothing shared yet', 8000)
      await A.shot('s21-empty-space', runDir)
    })
    await r.ok('the empty space offers the sharing docs card', async () => {
      await A.waitText('What happens when you share', 8000)
      assert(await A.has({ role: 'link', contains: 'When members can download from you' }), 'availability link present')
      assert(await A.has({ role: 'link', contains: 'Share individual files' }), 'share-files link present')
      assert(await A.has({ role: 'link', contains: 'Share a whole folder' }), 'share-folder link present')
      await A.shot('s21-empty-space-docs', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
