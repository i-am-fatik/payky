# Payment sync (FIO, Spark & Cashu)

How the FIO (bank IBAN) and Spark (Bitcoin/Lightning) background jobs turn
external activity into local data. Complements `docs/bill-payment-states.md`,
which covers what a `reconciliationClaim` means to a payment/bill; this
covers how one (and the `accountTransaction` behind it) gets created.

## Flow

Both jobs do the same two things per new item (FIO statement line / Spark
transfer) in one mutation batch:

1. **Find candidate** → match an unclaimed `payment` by method identifiers
   before writing, using the raw incoming item.
2. **Record + reconcile** → an `accountTransaction` row + kind detail row
   (`accountTransactionIban` / `accountTransactionSpark`+`Lightning`/
   `SparkInvoice`) plus the optional `reconciliationClaim` and bill
   `closedAt` cache. The claim makes a payment display **Paid**.

Already-recorded transactions still run the standalone reconciliation step to
repair rows created before this batching existed.

## Files

| File | Role |
|---|---|
| `background-jobs/background-job-types.ts` | `BackgroundJob`/`BackgroundJobContext` shape. |
| `background-jobs/background-jobs.ts` | Which jobs run on which runtime. |
| `background-jobs/run-background-jobs.ts` | Starts jobs, composes disposables. |
| `background-jobs/keyed-task-queue.ts` | Per-key sequential queue, used by every session below. |
| `background-jobs/reconcile-account-sync-sessions.ts` | Diffs active accounts/plugins against running sessions. |
| `background-jobs/jobs/fio-account-transaction-sync-job.ts` | The FIO job. |
| `background-jobs/jobs/spark-account-transaction-sync-job.ts` | The Spark job. |
| `account-transaction/account-transaction-actions.ts` | `createAccountTransaction` — the record step. |
| `reconciliation-claim/reconciliation-claim-actions.ts` | `loadAutomaticReconciliation` and `upsertAutomaticReconciliationRows`, the reconcile step, and `reconcileAccountTransaction`, the standalone one. |
| `integrations/fio/fio-client.ts` | FIO HTTP client. |
| `spark/spark-wallet.ts` | Pooled, ref-counted Spark SDK wrapper. |
| `account/account.ts`, `account-spark-queries.ts` | `sparkAccountSyncPointer` table + query. |
| `components/app/app-background-jobs.tsx` | Starts/stops jobs once per app mount. |
| `table-self-pay/table-self-pay-actions.ts` | `loadSelfPayArrival`, the self-pay candidate, which looks up the selection a payment points to. |
| `table-self-pay/table-self-pay-pointer-utils.ts` | The pointer a payment carries: the selection's hash, its keys and its event. |
| `background-jobs/jobs/self-pay-pointer-job.ts` | Asks again for selections that were not found yet. |
| `background-jobs/jobs/table-self-pay-publishing-job.ts` | Publishes each self-pay table's view to Nostr relays. |

## Parameters

| | FIO | Spark |
|---|---|---|
| Trigger | per-plugin timer | account-wide timer + wallet events (`transfer:claimed`, `balance:update`, `deposit:confirmed`) |
| Default interval | 30s (`numberOfSecondsBetweenChecks`) | 60s (`DEFAULT_RECHECK_INTERVAL_MS`) |
| Sync pointer | `fioPluginSyncPointer.lastSyncedDate` | `sparkAccountSyncPointer.lastSyncedAt` |
| Lookback overlap | `syncLookbackDays`, default **1 day**, per-plugin | `SPARK_SYNC_LOOKBACK_HOURS` = **72h**, fixed |
| Cold-start scan | 2 months back (`FIO_FIRST_SYNC_LOOKBACK_MONTHS`) | unbounded (full history) |
| Advisory lock key | `fio-transaction-{accountId}-{bankReference}` | `spark-transfer-{id}` |
| Queue keys per session | `"sync"` (single) | `"history"` + `` `transfer:${id}` `` (multi) |
| Manual pointer edit | Settings UI only | Settings UI + CLI (`apps/cli/src/cli-accounts.ts set/reset-spark-sync-pointer`) |

Both locks use `{ ifAvailable: true }` — skip on contention, never wait.
Both pointers are wall-clock values (sync start time), not derived from any
record's own timestamp, so a quiet sync still advances the window forward.

FIO only runs native/CLI (no CORS/proxy for browser); Spark runs everywhere.

## Multi-device & idempotency

A FIO plugin / Spark account is normal synced Evolu data — every device
independently runs its own sync job for it, with no leader election. Safety
comes from convergence, not coordination:

- `accountTransaction.id` derives from `accountId` + bank reference (FIO) or
  `sparkTransferId` (Spark) — two devices recording the same thing write the
  same CRDT row.
- `reconciliationClaim.id` derives from `` `{source}:${paymentId}:${accountTransactionId}` ``
  — same reasoning.
- The advisory locks above are **per-device only**; they mainly guard a
  session against itself (e.g. old/new session overlap after a token or
  secret change), not against other devices.

## Reconciliation

`reconcileAccountTransaction(id)`: return the existing claim if one's
active; else run these three candidate queries in parallel (`kind` picks at
most one winner) and claim the first match, ties broken by `payment.id`:

| Kind | Match | Reachable from these jobs? |
|---|---|---|
| `iban` | account + variable symbol (+ specific symbol, or both null) + amount + currency | yes |
| `spark` | account + `BTC` + amount(sats) + Lightning or Spark invoice match | yes |
| `cashRegister` | account + amount + currency | no — only `markPaymentPaidCash` creates this kind |
| `cashu` | account + mint + the payment's quote id, or the receive id it holds; never the amount | yes — the Cashu job |

No match = transaction stays unclaimed; not an error. A claim also refreshes
the bill's `closedAt` cache in the same batch (see `bill-payment-states.md`).

## Cashu

`background-jobs/jobs/cashu-account-sync-job.ts` serves the Cashu account
(`cashu.md` §5, the `cashu/` decisions). It runs on native and browser, not
in the CLI, and only while the Cashu account is enabled. The wallet is
Linky's own, read and written through `core/cashu/cashu-shard-store.ts`.

| Part | What it does |
|---|---|
| Lightning settlement | Every 5 s it polls the pending `topup` operations Payky's payments hold (and recent `autoswap`s) on Linky's schedule — 5 s for 5 minutes, 1 minute up to an hour, then 5 minutes — and claims a paid quote (`claimCashuTopup`). A claim made elsewhere is waited for; after 5 minutes it is reclaimed from the synced counter. |
| Melts | Melts this device sent that are still `pending` are resumed (`resumeCashuMelt`); a withdrawal's movement or failure follows (`settleCashuWithdrawal`). |
| Tokens | `core/cashu/cashu-token-listener.ts` reads 1:1 NIP-17 messages with a token (7-day window), matches them to a payment, makes the payment hold the receive id, and receives the token; a message whose mint is down is retried every 30 s. |
| Booking | `core/cashu/cashu-booking.ts` turns every `done` incoming operation into one `accountTransaction` (+ `accountTransactionCashu`) with the automatic claim in the same batch. It reads only changes newer than the `_cashuBookingCursor` rowid in `evolu_history`; without a cursor it books the last month. Triggered on start, on any wallet change, and every minute. |

Multi-device safety comes from Linky's rules, not locks: operation ids derive
from the mint and quote (or the token text), the claim stops when someone else
got there first (`cashu/0004`), and the booked transaction's id derives from
the operation id.

## Table self-pay

Why it is built this way is in
[table-self-pay-design.md](table-self-pay-design.md).

A guest paying at the table never asks a device for anything, so no
`payment` exists before the money does. The guest publishes what they pay
for to the relays, and the payment points to it. When none of the three candidates
above matches, both the new-transaction path and `reconcileAccountTransaction`
try a fourth, `loadSelfPayArrival`:

| Rail | Bill reference from | Credited amount | Also required |
|---|---|---|---|
| bank | the variable symbol | the transfer's amount | the bill's currency |
| Lightning | the memo of the invoice, `PK1 <ref> <pointer> A<amount> R<msat per unit>.<valid from>.<MAC>` | `min(amount, sats at the named rate)` | the rate's MAC, the invoice's own timestamp within one hour of the rate's start, and the money arriving at most ten minutes after that hour |

On both rails the reference must name exactly one stored
`billSelfPayReference`, the bill must know its `deviceId`, and the credit
must reach the self-pay minimum, 1.00 CZK, 0.05 EUR or 0.05 USD, or cover
everything the bill still owes (table-self-pay/0011). Anything else stays
unclaimed for staff.
The rate's MAC needs the table self-pay key, derived from the master key and
handed to the background jobs of every device, the CLI with a recovery phrase
included (`docs/decisions/account/0006`).

A match writes, in the transaction's own batch on the sync path: the
`payment` (the bill's device, the credited amount, the tip), its
`paymentIban` or `paymentBtc` + `paymentBtcLightning` row, its
`paymentSelfPay` pointer, a `selfPayAllocation` per paid line, the claim and
the bill's `closedAt` cache. The payment id derives from
`self-pay:{accountTransactionId}`, and every value but a bank claim's
`claimedAt` and the `closedAt` cache, which take this device's clock, comes
from the transaction, its message or memo, the selection it points to, the
bill and its stored versions,
so two devices recording the same arrival write the same rows apart from
those two values. `claimedAt` is the sale time EET reports (`docs/eet.md`): for
Lightning the transaction's `occurredAt`, when Spark received the money, and
for a bank transfer the time the device matched it, because FIO books only
a date and its midnight would come before the guest paid. The bank message
`PK1<pointer>`, 35 characters, travels in FIO's recipient message, which
`accountTransactionIban` keeps in its own `recipientMessage` column. The memo
is at most 108 bytes.

### The pointer

The pointer is 32 base32 characters, the first 160 bits of SHA-256 over the
selection the guest published (table-self-pay/0020). The device derives the
event's author from the pointer and the account's selection key, asks the
active and default relays for that author only (`lookUpSelfPaySelection`),
and keeps a selection only when its content hashes to the pointer and it names
the bill the reference names. The selection carries the split (lines with a
fraction each, lines with one common fraction, the rest of the bill, 1/N of
the bill, an amount) and the version of the bill the guest saw. The device
takes that version from the `selfPayViewVersion` rows of the bill or, while
the bill is open at a table, the bill as it stands, prices the share with
`calculateSelfPayShare`, the function the guest page used, and allocates it to
the lines the bill still has. The tip is what the credit holds above the
share. A credit below the share, or a selection that names another version
of the bill, counts toward the bill without allocation and without a tip.
Allocations mark lines paid and never change coverage.

When no relay returns the selection, the transaction stays unclaimed and
`self-pay-pointer-job.ts` asks again at 1, 3, 6 and 11 minutes after the device
first saw it. After 10 minutes the money counts toward the bill without
allocation. A pointer cut short does not parse and counts at once.

### Publishing the view

`table-self-pay-publishing-job.ts` runs on native and browser runtimes and in
the CLI with a recovery phrase.
Two seconds after anything at a self-pay table changes, it projects the
table's open bills into a view, stores each bill of it as a
`selfPayViewVersion` whose id comes from its content, then encrypts the
view under the table's view key and publishes it to every configured relay
as one replaceable event. A view that would not fit 60 KiB lists the bills
with the most lines by their totals only, and leaves out the newest bills
when even that does not fit. Versions are deleted 7 days after their bill
closed or was canceled. The bill's reference stays, but money naming it that
arrives later stays unmatched. The event's `created_at` is the newest
`createdAt` or `updatedAt` among every row that feeds the view, so a device
behind on sync publishes an older version and cannot displace a fresher one,
and equal views from two devices are one event. When the view or its relays
change without a newer row, it is one second after this device's last event
for that view, which the device keeps across restarts. While a table has an open bill, a separate liveness event
every five minutes names the view its device published last, which the guest
page counts as confirmed only when it shows that view or a newer one
(table-self-pay/0014), and carries the signed Lightning rate when the view offers
Lightning, valid for one hour from its start. Guests ask relays only for events the table's key signed. Switching self-pay off
publishes a view telling guests to pay with staff, and regenerating the QR
publishes that view under every earlier key of the table.

## Known limitations

| # | Issue | Status |
|---|---|---|
| 1 | Spark transfer with no Lightning/Spark invoice | open by design — never recorded |
| 2 | Ambiguous candidate ties | open — `payment.id` order decides |
| 3 | Two devices publishing different views of one table within the same second | open — relays keep the lower event id until the next change |
| 4 | A selection naming a version another device published and this one has not synced | open, rare |
| 5 | A view that changed without a newer row, published by another device | open, until the table changes again |
| 6 | A view nobody changed for 30 days | open by design, the event expires |

1. **By design**, not a bug: `assertHasSparkIdentifier` is a domain
   invariant enforced inside `createAccountTransaction` itself.

2. **Ties.** IBAN candidate: same VS/SS/amount on two open payments. Cash
   candidate: same amount (currently unreachable, see the table above).

3. **Same-second views.** A view's version has one-second resolution. If a
   device behind on sync publishes within the same second as a fresh one,
   relays break the tie by event id, and the stale view can stay until the
   table changes again.

4. **Unsynced version.** The device also tries the bill as it stands while
   it is open at its table, which matches whenever nothing changed since the
   guest looked. Otherwise the
   money counts toward the bill without allocation.

5. **Bump kept per device.** When a view changes without a newer row, for
   example when Spark becomes unreachable and the view drops Lightning, or a
   bill moves to another table, the device publishes it one second above its
   own last event. It stores the second of every event it publishes as a
   `selfPayViewPublication` row, so after a restart it goes on from there.
   Another device knows only its own bumps, so it publishes the same view at
   its row version, below the bumped event, and relays keep the bumped one
   until the table changes again. Following another device's bump would let
   a device behind on sync displace a fresher view.

6. **Idle views expire.** A view's event expires 30 days after its version.
   A table nobody changed for 30 days tells guests that its bill is not
   available until its next change.
