# CLA signature storage

This orphan branch exists solely so that `contributor-assistant/github-action`
(configured in `.github/workflows/cla.yml` on the default branch) can write
contributor signatures to `signatures/cla.json`.

Do not protect this branch — the action must be able to commit to it.
Do not delete it — the CLA check fails with "Branch cla-signatures not found".
