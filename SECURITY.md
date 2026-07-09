# Security Policy

## Reporting a vulnerability

Please **do not report security vulnerabilities through public GitHub issues.**

Email **security@mirall.app** instead. Include as much of the following as you can:

- A description of the issue and its impact
- Steps to reproduce (a proof of concept helps a lot)
- The Mirall version (Settings → About) and your operating system

You will receive an acknowledgement, typically within a few days. Please give us reasonable
time to investigate and ship a fix before any public disclosure — security fixes are
prioritized over all other work and are delivered to all users automatically via the app's
built-in update mechanism.

## Supported versions

Mirall updates itself automatically over its peer-to-peer update channel, so the **latest
release is the only supported version**. If you disabled updates or pinned an old version,
please update before reporting.

## Scope

In scope: the desktop application in this repository — the protocol implementation
(handshake, membership, transfers), the encryption of data at rest and in transit, the
update mechanism, and the Electron shell.

The security model (identity keys, per-space content keys, membership approval, serve
authorization) is documented in
[`.claude/solution-architecture.md`](./.claude/solution-architecture.md) — reports that
show a documented guarantee being violated are especially valuable.
