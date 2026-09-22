# P2.0 spikes

Throwaway harnesses for the two decisions that gate the daemon runtime. Nothing here ships; the
decision record lives in the daemon-arc plan and the durable facts are pinned by
`test/integration/bare-watch-facts.test.js` and `test/integration/updater-stages-under-bare.test.js`.

## S1 — recursive watch under Bare

```
node scripts/spikes/s1-drive.mjs --mode native --out /tmp/s1-native
node scripts/spikes/s1-drive.mjs --mode tree   --out /tmp/s1-tree
```

The driver spawns `s1-bare-watch.mjs` under `bare`, runs the mutation matrix (M1–M9) against a
temp root and scores hit rate, latency p50/p95 and events per mutation from the two NDJSON logs.
`--inotify-limit 1024` runs M9 on Linux; it writes `/proc/sys/fs/inotify/max_user_watches` and
restores it, so it needs a privileged container or root. `--apply` refuses a path outside the
scratch dir without `--apply-outside-dir`.

## S2 — updater staging inside a Bare process

```
node scripts/spikes/s2-seed.mjs --size 1048576 --executable
node scripts/spikes/s2-seed.mjs --size 100000000 --data-store
node scripts/spikes/s2-seed.mjs --apply                  # U4: a scratch file stands in for the AppImage
node scripts/spikes/s2-seed.mjs --bundle --apply         # U6: a scratch directory bundle
node scripts/spikes/s2-seed.mjs --apply --apply-outside-dir --app /opt/Mirall/mirall   # U5, as an unprivileged user
```

The seed builds a Hyperdrive with `/package.json` at `9.9.9` and a random payload under
`/by-arch/<host>/app/<name>`, serves it on a hermetic `hyperdht/testnet`, and spawns
`s2-bare-stage.mjs` under `bare`, which constructs `pear-runtime-updater` the way
`src/main/updater.js` does and reports what it staged.

## Linux legs

Both archs run in Docker from a copy of `package.json` + `package-lock.json` installed with
`npm ci --ignore-scripts` (then `chmod +x` on the `bare-runtime-linux-*` binary), with
`scripts/spikes` bind-mounted in.
