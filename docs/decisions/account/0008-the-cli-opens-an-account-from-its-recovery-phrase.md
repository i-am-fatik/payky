# 0008 The CLI opens an account from its recovery phrase, in a database file of its own

Status: accepted
Date: 2026-10-15

## Context

A browser or PWA cannot reach the Fio API, so an account used only there
never synced its Fio transactions. The CLI could run the Fio sync, but only
on the public Evolu test owner, which is no account and never syncs. Evolu
does not tie a database file to one owner, so a file two accounts share mixes
their rows in every query. Without the self-pay root, the Spark sync would
record a guest's Lightning payment and never credit it.

## Decision

- With `PAYKY_RECOVERY_MNEMONIC` the CLI derives the account's master key,
  and from it the Evolu owner and the self-pay root the app derives. It syncs
  that owner through the default Evolu relays.
- Its database file defaults to one per owner, `.data/payky-<ownerId>.db`.
- It reads the phrase only from the environment. No command takes it as an
  argument.
- Without a phrase it opens the public Evolu test owner on no relay, so
  nothing it writes leaves the file.

## Alternatives considered

None recorded.

## Consequences

- Whoever reads the phrase, the environment of the CLI's process or its
  database file holds the account, its wallet included.
- The CLI syncs through every default relay. The relays an app device
  switches off live in that device's own database, which the CLI does not
  read.
- What the CLI does as a device of the account is account/0006.

## Enforced by

- `apps/cli/src/cli-evolu.test.ts > createCliEvolu > syncs two databases opened with one master key through a relay`
- `apps/cli/src/cli-evolu.test.ts > createCliEvolu > carries the self-pay root of its account, and none without one`
