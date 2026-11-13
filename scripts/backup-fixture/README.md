# Backup fixture generator

`generate.mjs` writes the frozen backup folder for one release into `test/fixtures/backup/<x.y.z>/`.
It runs inside a checkout of that release's tag, so the bytes come from that release's code and its
locked dependencies. Run it once per stable tag; a fixture is never regenerated (see
`test/fixtures/backup/SOURCES.md`).

```sh
REPO=$(git rev-parse --show-toplevel)
V=1.14.0
git worktree add --detach ../tmp-fixture-$V v$V
cd ../tmp-fixture-$V && npm ci
mkdir -p scripts/backup-fixture && cp "$REPO/scripts/backup-fixture/generate.mjs" scripts/backup-fixture/
node_modules/.bin/bare scripts/backup-fixture/generate.mjs --out "$REPO/test/fixtures/backup/$V" --version $V
cd "$REPO" && git worktree remove --force ../tmp-fixture-$V
```

Then, in the main checkout:

1. Append the new files' sums: `cd test/fixtures/backup && find $V -type f | LC_ALL=C sort | xargs shasum -a 256 >> SHA256SUMS`.
2. Add the release's row to `SOURCES.md`: tag commit, the dependency versions from that tag's
   `package-lock.json`, the generator's sha256, the OS it ran on, file count and bytes.
3. Run `test/invariants/backup-fixtures-frozen.test.js` and `test/integration/backup-compat.test.js`.

The script refuses a `--version` that does not match the checkout's `package.json`, an `--out` that
is not empty, and a copy of itself outside the checkout it runs in. It works in
`/tmp/mirall-backup-fixture` and removes it. A release whose calls differ from the defaults gets a
row in its `ADAPTERS` table; a new release that needs none adds nothing there.
