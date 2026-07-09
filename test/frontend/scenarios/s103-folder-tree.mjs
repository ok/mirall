import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { findNode } from '../tree.mjs'
import { workDir } from '../paths.mjs'

// Collapsible folder tree in FolderView: nested folders render as disclosure rows
// (folder buttons AX-targetable by name/role), top-level folders open by default
// while deeper ones stay collapsed, and expand/collapse + collapse-all/expand-all
// reveal and hide leaves. Leaves show basenames; the flat-list rendering is gone.
export default async function s103 ({ runDir }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', slot: 0, total: 1 })

  const ownDir = path.join(workDir('own-'), 'Q3 Campaign')
  const tree = ['README.txt', 'Brand/Logos/logo-primary.svg', 'Brand/Photos/hero-01.jpg', 'Briefs/creative-brief.pdf']
  mkdirSync(path.join(ownDir, 'Brand', 'Logos'), { recursive: true })
  mkdirSync(path.join(ownDir, 'Brand', 'Photos'), { recursive: true })
  mkdirSync(path.join(ownDir, 'Briefs'), { recursive: true })
  for (const rel of tree) writeFileSync(path.join(ownDir, ...rel.split('/')), `content of ${rel}`)

  try {
    await r.ok('launch + create space + own the nested folder + open it', async () => {
      await A.launch()
      // Add-Folder is registered only in space-view, so enter a space first.
      await A.createSpaceOnly('Aurora')
      await A.addOwnedFolder(ownDir)
      await A.waitText('Q3 Campaign', 60000)
      await A.openFolder('Q3 Campaign')
    })

    await r.ok('top-level folders open by default; deeper leaves stay hidden', async () => {
      await A.waitText('Brand', 20000)
      await A.waitText('Logos', 10000) // Brand is top-level → open → its subfolder rows show
      assert(await A.hasText('Briefs'), 'Briefs top-level folder listed')
      assert(await A.hasText('Photos'), 'second subfolder under Brand listed')
      assert(await A.hasText('README.txt'), 'loose top-level file listed by basename')
      assert(await A.hasText('creative-brief.pdf'), 'file in an open top-level folder listed')
      assert(!(await A.hasText('logo-primary.svg')), 'leaf inside a collapsed subfolder is hidden')
      assert(!(await A.hasText('hero-01.jpg')), 'leaf inside a collapsed subfolder is hidden')
    })

    await r.ok('folder rows are AX-targetable buttons', async () => {
      const btn = findNode(await A.snap(), { role: 'button', name: 'Logos' })
      assert(btn, 'Logos folder is a button reachable by name + role')
    })

    await r.ok('expanding a subfolder reveals its leaf', async () => {
      await A.click({ role: 'button', name: 'Logos' })
      await A.waitText('logo-primary.svg', 10000)
    })

    await r.ok('Collapse all hides every folder’s contents but keeps the folder rows', async () => {
      await A.click({ role: 'button', name: 'Collapse all' })
      await waitFor(async () => !(await A.hasText('logo-primary.svg')), 10000, 'leaf hidden after collapse all')
      assert(!(await A.hasText('creative-brief.pdf')), 'top-level folder contents hidden after collapse all')
      assert(await A.hasText('Brand'), 'top-level folder rows remain after collapse all')
    })

    await r.ok('Expand all reveals every nested leaf', async () => {
      await A.click({ role: 'button', name: 'Expand all' })
      await A.waitText('logo-primary.svg', 10000)
      assert(await A.hasText('hero-01.jpg'), 'all nested leaves revealed after expand all')
      await A.shot('s103-expanded-all', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
