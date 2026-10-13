# 0006 The CLI with a recovery phrase is a device of the account and runs every job a native device runs

Status: accepted
Date: 2026-10-13

## Context

A till that runs only as a PWA stops when its tab sleeps. With no app open,
nothing published the self-pay view or the signed Lightning rate. On
2026-10-13 a guest's phone kept asking for money the CLI had already
matched, and guests could not mint a Lightning invoice until someone
opened the app. The CLI already opens the account from its recovery phrase
(`PAYKY_RECOVERY_MNEMONIC`) to run the Fio and Spark syncs, so it holds
everything a device needs.

## Decision

- `background-jobs run` with a recovery phrase runs as a device of the
  account. It keeps one device id per database file, in
  `<database>.device-id` readable only by its user, and registers its
  device row on start like the app does (access/0004): named
  `CLI on <hostname>`, type `cli`, holding no permissions.
- It runs the jobs of a native device: Fio sync, Spark sync, EET reporting
  and self-pay publishing, with the device id and the self-pay root the
  app derives from the same master key. It publishes to the account's
  self-pay relays (table-self-pay/0003), whose defaults it takes from
  `PAYKY_SELF_PAY_RELAYS`.
- Without a recovery phrase it runs no job and says it needs one. The
  public Evolu test owner it would open is no account, and its tables must
  not reach real relays or EET.

## Alternatives considered

- Keeping the CLI to the Fio and Spark syncs, which leaves self-pay guests
  without a confirmed view or a Lightning rate whenever no app is open.
- A device database for the CLI like the app's. The CLI holds one account
  per database file and no PIN or settings, so a file with the id is
  enough.
- A device id derived from the owner and the hostname, which collides for
  two CLIs on one computer and changes when the computer is renamed.

## Consequences

- The CLI never records a settlement itself: a self-pay payment belongs to
  the device that opened its bill, and an automatic match to the device
  that created the payment. In EET it only takes over another device's
  sale after 10 minutes, as eet/0009 lets any device do. For withdrawals
  it is another device, so withdraw/0007's 24 hours still apply to it.
- An app and a CLI that share the Fio tokens poll one at a time, the one
  that runs the most (payment/0007).
- Every new database file is a new device row, which the owner removes in
  Settings → Access when it is stale.

## Enforced by

- `apps/cli/src/cli-device.test.ts > CLI device > keeps one device id per database, in a file only its user reads`
- `apps/cli/src/cli-device.test.ts > CLI device > registers as a device named after the computer, holding no permissions, and keeps a name the owner gave it`
- `apps/cli/src/cli-evolu.test.ts > createCliEvolu > carries the self-pay root of its account, and none without one`
