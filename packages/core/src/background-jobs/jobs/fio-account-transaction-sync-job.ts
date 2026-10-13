import { err, ok, type Result, type Run, type Task } from "@evolu/common"
import { format, subDays, subMonths } from "date-fns"
import type { DeviceIdDep } from "../../deps.ts"
import {
  createFioApiDep,
  type FioAllTokensRestingError,
  type FioApiDep,
  type FioRateLimitError,
  type FioTransaction,
  fetchFioTransactionsByPeriod,
} from "../../integrations/fio/fio-client.ts"
import {
  computeAccountTransactionRows,
  upsertAccountTransactionRows,
} from "../../modules/account-transaction/account-transaction-actions.ts"
import type { AccountTransactionId } from "../../modules/account-transaction/account-transaction-types.ts"
import type { DeviceId } from "../../modules/device/device-types.ts"
import { defaultFioPluginSyncLookbackDays } from "../../modules/fio-plugin/fio-plugin-actions.ts"
import {
  activeFioPluginsQuery,
  existingFioTransactionBankReferencesQuery,
  fioPluginSyncLeaseByPluginIdQuery,
  fioPluginSyncPointerByPluginIdQuery,
  fioSyncDeviceUptimeByDeviceIdQuery,
} from "../../modules/fio-plugin/fio-plugin-queries.ts"
import type { FioPluginId } from "../../modules/fio-plugin/fio-plugin-types.ts"
import { fioSyncDeviceUptimeId } from "../../modules/fio-plugin/fio-plugin-utils.ts"
import {
  loadAutomaticReconciliation,
  reconcileAccountTransaction,
  SELF_PAY_ARRIVAL_LOCK,
  upsertAutomaticReconciliationRows,
} from "../../modules/reconciliation-claim/reconciliation-claim-actions.ts"
import {
  dateStringToDate,
  dateToDateString,
} from "../../modules/shared/date-string-utils.ts"
import {
  removeUndefinedValues,
  runMutationWithCompletion,
} from "../../modules/shared/evolu-utils.ts"
import {
  type DateString,
  DateStringSchema,
  IntegerSchema,
  NonEmptyString255Schema,
  NonEmptyStringSchema,
  NonNegativeIntegerSchema,
  TimestampMsSchema,
} from "../../modules/shared/schema.ts"
import type { BackgroundJobContext } from "../background-job-types.ts"
import { createKeyedTaskQueue } from "../keyed-task-queue.ts"
import { reconcileAccountSyncSessions } from "../reconcile-account-sync-sessions.ts"

type Context = BackgroundJobContext & DeviceIdDep

const FIO_FIRST_SYNC_LOOKBACK_MONTHS = 2
const FIO_MAX_RETRY_BACKOFF_MS = 15 * 60 * 1000
const FIO_SYNC_LEASE_MS = 10 * 60 * 1000
const FIO_SYNC_TAKEOVER_UPTIME_MARGIN = 0.1
const FIO_SYNC_UPTIME_TIME_CONSTANT_MS = 24 * 60 * 60 * 1000
const FIO_SYNC_UPTIME_TICK_MS = 60 * 1000
const FIO_SYNC_UPTIME_MAX_TICK_GAP_MS = 2 * FIO_SYNC_UPTIME_TICK_MS
const FIO_SYNC_UPTIME_SAVE_MS = 30 * 60 * 1000

export const getFioRetryBackoffMs = (
  secondsPerToken: number,
  failedSyncCount: number
): number =>
  Math.min(
    secondsPerToken * 1000 * 2 ** (failedSyncCount - 1),
    FIO_MAX_RETRY_BACKOFF_MS
  )

export const getFioCheckIntervalMs = (
  secondsPerToken: number,
  tokenCount: number
): number => Math.ceil((secondsPerToken * 1000) / tokenCount)

type FioSyncLeaseDecision =
  | { readonly poll: false }
  | {
      readonly poll: true
      readonly renewLease: boolean
      readonly takenOverAt: number | null
    }

interface FioSyncLease {
  readonly deviceId: DeviceId
  readonly expiresAt: number
}

export const decideFioSyncLease = ({
  lease,
  deviceId,
  uptime,
  holderUptime,
  now,
}: {
  readonly lease: FioSyncLease | undefined
  readonly deviceId: DeviceId
  readonly uptime: number
  readonly holderUptime: number
  readonly now: number
}): FioSyncLeaseDecision => {
  if (lease === undefined)
    return { poll: true, renewLease: true, takenOverAt: null }
  if (lease.deviceId === deviceId) {
    return {
      poll: true,
      renewLease: lease.expiresAt - now <= FIO_SYNC_LEASE_MS / 2,
      takenOverAt: null,
    }
  }
  const runsClearlyMore =
    uptime >= holderUptime + FIO_SYNC_TAKEOVER_UPTIME_MARGIN
  if (lease.expiresAt > now && !runsClearlyMore) return { poll: false }

  return {
    poll: true,
    renewLease: true,
    takenOverAt: Math.min(now, lease.expiresAt),
  }
}

interface FioSyncUptimeStep {
  readonly uptime: number
  readonly elapsedMs: number
}

const fioSyncUptimePastWeight = (elapsedMs: number): number =>
  Math.exp(-Math.max(0, elapsedMs) / FIO_SYNC_UPTIME_TIME_CONSTANT_MS)

export const fioSyncUptimeAfterRunning = ({
  uptime,
  elapsedMs,
}: FioSyncUptimeStep): number =>
  1 - (1 - uptime) * fioSyncUptimePastWeight(elapsedMs)

export const fioSyncUptimeAfterOff = ({
  uptime,
  elapsedMs,
}: FioSyncUptimeStep): number => uptime * fioSyncUptimePastWeight(elapsedMs)

const loadActiveFioPlugins = (deps: Context) =>
  deps.evolu.loadQuery(activeFioPluginsQuery)

type ActiveFioPlugin = Awaited<ReturnType<typeof loadActiveFioPlugins>>[number]
type FioPluginToken = ActiveFioPlugin["tokens"][number]
type ActiveFioPluginWithTokens = ActiveFioPlugin & {
  readonly tokens: readonly [FioPluginToken, ...FioPluginToken[]]
}

export const createFioAccountTransactionSyncJob =
  (): Task<AsyncDisposable, never, Context> => (run) => {
    // A fresh `run.create()` scope, not the Task's own `run`: that one is
    // disposed the instant this Task function returns, but the sync classes
    // below keep composing Tasks (via their stored `run`) for as long as the
    // job itself runs. Explicitly disposed in the returned disposable below —
    // see AGENTS.md and `createRun`'s doc comment on why a detached
    // `createRun` call per transaction (the previous shape here) leaks a root
    // Evolu never gets to dispose.
    const jobRun = run.create({
      ...run.deps,
      console: run.deps.console.child("fio-account-transaction-sync-job"),
    })
    const sync = new FioAccountTransactionSync(jobRun)

    sync.start()

    const disposer = new AsyncDisposableStack()
    disposer.use(jobRun)
    disposer.defer(() => sync.dispose())

    return ok(disposer)
  }

export const startFioAccountTransactionSyncJob =
  createFioAccountTransactionSyncJob()

class FioAccountTransactionSync {
  private readonly pluginSyncs = new Map<FioPluginId, FioPluginSync>()
  private readonly restingUntilByToken = new Map<string, number>()
  private readonly unsubscribePlugins: () => void
  private readonly run: Run<Context>
  private uptime: FioSyncUptime | null = null
  private readonly refreshQueue = createKeyedTaskQueue<"refresh">({
    onError: (error) => this.run.deps.onError(error),
  })

  constructor(run: Run<Context>) {
    this.run = run
    this.unsubscribePlugins = run.deps.evolu.subscribeQuery(
      activeFioPluginsQuery
    )(() => {
      this.queueRefresh()
    })
  }

  start(): void {
    this.run.deps.console.info("Started FIO account transaction sync job.")
    this.queueRefresh()
  }

  async dispose(): Promise<void> {
    if (this.refreshQueue.isDisposed) return

    this.unsubscribePlugins()
    await this.refreshQueue[Symbol.asyncDispose]()

    for (const [pluginId, sync] of this.pluginSyncs) {
      await sync.dispose()
      await releaseFioSyncLease(this.run.deps, pluginId)
    }
    this.pluginSyncs.clear()
    await this.uptime?.dispose()
    this.run.deps.console.info("Stopped FIO account transaction sync job.")
  }

  private queueRefresh(): void {
    this.refreshQueue.enqueue("refresh", () => this.refreshPlugins())
  }

  private async refreshPlugins(): Promise<void> {
    const plugins = await loadActiveFioPlugins(this.run.deps)
    const activePlugins = plugins.filter(hasFioTokens)

    this.run.deps.console.debug("Refreshing FIO plugin syncs.", {
      activePluginCount: activePlugins.length,
      pluginCount: plugins.length,
      runningPluginCount: this.pluginSyncs.size,
      skippedPluginWithoutTokenCount: plugins.length - activePlugins.length,
    })

    const stoppedPluginIds: FioPluginId[] = []
    await reconcileAccountSyncSessions({
      sessions: this.pluginSyncs,
      activeAccounts: activePlugins,
      getKey: (plugin) => plugin.id,
      matches: (sync, plugin) => sync.matches(plugin),
      createSession: (plugin) => {
        this.uptime ??= new FioSyncUptime(this.run)
        const sync = new FioPluginSync(
          this.run,
          plugin,
          this.uptime,
          this.restingUntilByToken
        )
        sync.start()
        return sync
      },
      disposeSession: (sync) => sync.dispose(),
      onSessionStopped: (pluginId) => {
        stoppedPluginIds.push(pluginId)
        this.run.deps.console.info("Stopped FIO plugin sync.", { pluginId })
      },
      onSessionStarted: (pluginId, plugin, replacedExistingSync) => {
        this.run.deps.console.info("Started FIO plugin sync.", {
          accountId: plugin.accountId,
          pluginId,
          replacedExistingSync,
          tokenCount: plugin.tokens.length,
        })
      },
    })
    for (const pluginId of stoppedPluginIds) {
      await releaseFioSyncLease(this.run.deps, pluginId)
    }
    if (this.pluginSyncs.size === 0) {
      await this.uptime?.dispose()
      this.uptime = null
    }
  }
}

class FioSyncUptime {
  private readonly run: Run<Context>
  private readonly timer: ReturnType<typeof setInterval>
  private readonly loaded: Promise<void>
  private uptime = 0
  private tickedAt: number
  private savedAt: number

  constructor(run: Run<Context>) {
    this.run = run
    this.tickedAt = run.deps.date.now().getTime()
    this.savedAt = this.tickedAt
    this.loaded = this.load().catch((error: unknown) =>
      this.run.deps.onError(error)
    )
    this.timer = setInterval(() => {
      this.tick()
      if (this.tickedAt - this.savedAt >= FIO_SYNC_UPTIME_SAVE_MS)
        this.save().catch((error: unknown) => this.run.deps.onError(error))
    }, FIO_SYNC_UPTIME_TICK_MS)
    ;(this.timer as { readonly unref?: () => void }).unref?.()
  }

  async current(): Promise<number> {
    await this.loaded
    return this.uptime
  }

  async dispose(): Promise<void> {
    clearInterval(this.timer)
    await this.loaded
    this.tick()
    await this.save()
  }

  private async load(): Promise<void> {
    const saved = await loadSavedFioSyncUptime(
      this.run.deps,
      this.run.deps.deviceId
    )
    this.uptime = fioSyncUptimeAfterOff({
      uptime: saved.uptime,
      elapsedMs: this.run.deps.date.now().getTime() - saved.measuredAt,
    })
    this.run.deps.console.debug("Loaded FIO sync uptime.", {
      uptime: this.uptime,
    })
    await this.save()
  }

  private tick(): void {
    const now = this.run.deps.date.now().getTime()
    const elapsedMs = now - this.tickedAt
    const advance =
      elapsedMs <= FIO_SYNC_UPTIME_MAX_TICK_GAP_MS
        ? fioSyncUptimeAfterRunning
        : fioSyncUptimeAfterOff
    this.uptime = advance({ uptime: this.uptime, elapsedMs })
    this.tickedAt = now
  }

  private async save(): Promise<void> {
    this.savedAt = this.tickedAt
    await runMutationWithCompletion((options) =>
      this.run.deps.evolu.upsert(
        "fioSyncDeviceUptime",
        removeUndefinedValues({
          id: fioSyncDeviceUptimeId(this.run.deps.deviceId),
          uptimePerMille: NonNegativeIntegerSchema.decode(
            Math.round(this.uptime * 1000)
          ),
          measuredAt: TimestampMsSchema.decode(this.tickedAt),
        }),
        { ...options, owner: this.run.deps.evoluOwner }
      )
    )
  }
}

const NEVER_MEASURED_FIO_SYNC_UPTIME = { uptime: 0, measuredAt: 0 }

const loadSavedFioSyncUptime = async (
  deps: Context,
  deviceId: DeviceId
): Promise<{ readonly uptime: number; readonly measuredAt: number }> => {
  const [saved] = await deps.evolu.loadQuery(
    fioSyncDeviceUptimeByDeviceIdQuery(deviceId)
  )
  if (saved === undefined) return NEVER_MEASURED_FIO_SYNC_UPTIME
  return { uptime: saved.uptimePerMille / 1000, measuredAt: saved.measuredAt }
}

const saveFioSyncLease = async (
  deps: Context,
  pluginId: FioPluginId,
  expiresAt: number
): Promise<void> => {
  await runMutationWithCompletion((options) =>
    deps.evolu.upsert(
      "fioPluginSyncLease",
      removeUndefinedValues({
        id: pluginId,
        deviceId: deps.deviceId,
        expiresAt: TimestampMsSchema.decode(expiresAt),
      }),
      { ...options, owner: deps.evoluOwner }
    )
  )
}

const releaseFioSyncLease = async (
  deps: Context,
  pluginId: FioPluginId
): Promise<void> => {
  const now = deps.date.now().getTime()
  const [lease] = await deps.evolu.loadQuery(
    fioPluginSyncLeaseByPluginIdQuery(pluginId)
  )
  if (lease?.deviceId !== deps.deviceId || lease.expiresAt <= now) return
  await saveFioSyncLease(deps, pluginId, now)
}

class FioPluginSync {
  private readonly timer: ReturnType<typeof setInterval>
  private readonly run: Run<Context>
  private readonly plugin: ActiveFioPluginWithTokens
  private readonly uptime: FioSyncUptime
  private readonly fioApiDep: FioApiDep
  private failedSyncCount = 0
  private nextRetryAt: number | null = null
  private restTimer: ReturnType<typeof setTimeout> | null = null
  private readonly syncQueue = createKeyedTaskQueue<"sync">({
    onError: (error) => this.run.deps.onError(error),
  })

  constructor(
    run: Run<Context>,
    plugin: ActiveFioPluginWithTokens,
    uptime: FioSyncUptime,
    restingUntilByToken: Map<string, number>
  ) {
    this.run = run
    this.plugin = plugin
    this.uptime = uptime
    // The dep lives as long as this sync session, and `matches()` restarts
    // the session whenever the token set changes, so the client-side
    // `takeToken` rotation always covers the current tokens.
    const [firstToken, ...restTokens] = plugin.tokens
    this.fioApiDep = createFioApiDep({
      tokens: [firstToken.token, ...restTokens.map((token) => token.token)],
      restingUntilByToken,
    })
    this.timer = setInterval(
      () => {
        this.queueSync()
      },
      getFioCheckIntervalMs(
        plugin.numberOfSecondsBetweenChecks,
        plugin.tokens.length
      )
    )
    ;(this.timer as { readonly unref?: () => void }).unref?.()
  }

  start(): void {
    this.queueSync()
  }

  async dispose(): Promise<void> {
    if (this.syncQueue.isDisposed) return

    clearInterval(this.timer)
    if (this.restTimer !== null) clearTimeout(this.restTimer)
    await this.syncQueue[Symbol.asyncDispose]()
  }

  matches(plugin: ActiveFioPlugin): boolean {
    return (
      this.plugin.accountId === plugin.accountId &&
      this.plugin.numberOfSecondsBetweenChecks ===
        plugin.numberOfSecondsBetweenChecks &&
      this.plugin.syncLookbackDays === plugin.syncLookbackDays &&
      this.plugin.iban === plugin.iban &&
      areTokensEqual(this.plugin.tokens, plugin.tokens)
    )
  }

  private queueSync(): void {
    if (
      this.nextRetryAt !== null &&
      this.run.deps.date.now().getTime() < this.nextRetryAt
    )
      return
    this.syncQueue.enqueue("sync", () => this.syncTransactions())
  }

  private retrySyncAt(at: number): void {
    this.restTimer = setTimeout(() => {
      this.restTimer = null
      this.syncQueue.enqueue("sync", () => this.syncTransactions())
    }, at - this.run.deps.date.now().getTime())
    ;(this.restTimer as { readonly unref?: () => void }).unref?.()
  }

  private async syncTransactions(): Promise<void> {
    try {
      const mayPoll = await this.holdLease()
      if (!mayPoll || this.syncQueue.isDisposed) return
      this.scheduleNextSync(await this.syncTransactionsOnce())
    } catch (error) {
      this.delayAfterFailedSync()
      throw error
    }
  }

  private scheduleNextSync(
    result: Result<void, FioRateLimitError | FioAllTokensRestingError>
  ): void {
    if (this.restTimer !== null) clearTimeout(this.restTimer)
    this.restTimer = null
    if (result.ok) {
      this.failedSyncCount = 0
      this.nextRetryAt = null
    } else if (result.error.type === "FioAllTokensRestingError") {
      this.nextRetryAt = result.error.retryAt
      this.retrySyncAt(result.error.retryAt)
    } else {
      this.delayAfterFailedSync()
    }
  }

  private async holdLease(): Promise<boolean> {
    const { deviceId, evolu } = this.run.deps
    const now = this.run.deps.date.now().getTime()
    const [lease] = await evolu.loadQuery(
      fioPluginSyncLeaseByPluginIdQuery(this.plugin.id)
    )
    const holderUptime =
      lease === undefined || lease.deviceId === deviceId
        ? 0
        : (await loadSavedFioSyncUptime(this.run.deps, lease.deviceId)).uptime
    const decision = decideFioSyncLease({
      lease,
      deviceId,
      uptime: await this.uptime.current(),
      holderUptime,
      now,
    })
    if (!decision.poll) {
      this.run.deps.console.debug(
        "Skipped FIO sync while another device holds the lease.",
        { lease, pluginId: this.plugin.id }
      )
      return false
    }
    if (decision.takenOverAt !== null) {
      const lastPossibleRequestAt = new Date(decision.takenOverAt)
      for (const { token } of this.plugin.tokens) {
        this.fioApiDep.fioApi.restToken(token, lastPossibleRequestAt)
      }
      this.run.deps.console.info("Took over the FIO sync lease.", {
        previousLease: lease,
        pluginId: this.plugin.id,
      })
    }
    if (decision.renewLease) {
      await saveFioSyncLease(
        this.run.deps,
        this.plugin.id,
        now + FIO_SYNC_LEASE_MS
      )
    }
    return true
  }

  private delayAfterFailedSync(): void {
    this.failedSyncCount += 1
    const retryInMs = getFioRetryBackoffMs(
      this.plugin.numberOfSecondsBetweenChecks,
      this.failedSyncCount
    )
    this.nextRetryAt = this.run.deps.date.now().getTime() + retryInMs
    this.run.deps.console.warn("Delayed FIO sync after a failed attempt.", {
      accountId: this.plugin.accountId,
      failedSyncCount: this.failedSyncCount,
      pluginId: this.plugin.id,
      retryInMs,
    })
  }

  private async syncTransactionsOnce(): Promise<
    Result<void, FioRateLimitError | FioAllTokensRestingError>
  > {
    const period = await this.getSyncPeriod()
    this.run.deps.console.info("Started FIO transaction sync.", {
      accountId: this.plugin.accountId,
      from: period.from,
      pluginId: this.plugin.id,
      to: period.to,
      tokenCount: this.plugin.tokens.length,
    })
    // Custom deps replace a Run's inherited ones rather than merging with
    // them (see `createRun`'s doc comment), so the fetch's extra `FioApiDep`
    // is layered on top of every dep this session's `run` already carries,
    // not passed alone.
    const result = await this.run(fetchFioTransactionsByPeriod(period), {
      ...this.run.deps,
      ...this.fioApiDep,
    })
    if (!result.ok && result.error.type === "FioRateLimitError") {
      this.run.deps.console.error(
        "Skipped FIO sync because of rate limiting.",
        {
          accountId: this.plugin.accountId,
          pluginId: this.plugin.id,
          responseBody: result.error.responseBody,
        }
      )
      return err(result.error)
    }
    if (!result.ok && result.error.type === "FioAllTokensRestingError") {
      this.run.deps.console.debug("Skipped FIO sync while every token rests.", {
        accountId: this.plugin.accountId,
        pluginId: this.plugin.id,
        retryAt: result.error.retryAt,
      })
      return err(result.error)
    }
    if (!result.ok) throw result.error
    if (result.value.iban !== this.plugin.iban) {
      this.run.deps.console.warn(
        "Skipped FIO statement for a different IBAN.",
        {
          accountId: this.plugin.accountId,
          expectedIban: this.plugin.iban,
          receivedIban: result.value.iban,
          pluginId: this.plugin.id,
        }
      )
      return ok()
    }

    const { toRecord, toReconcile } = await this.getTransactionsToRecord(
      result.value.transactions
    )
    this.run.deps.console.info("Selected FIO transactions to record.", {
      accountId: this.plugin.accountId,
      downloadedCount: result.value.transactions.length,
      pluginId: this.plugin.id,
      selectedCount: toRecord.length,
      skippedCount: result.value.transactions.length - toRecord.length,
    })
    let skippedLockedTransaction = false
    for (const transaction of toRecord) {
      if (this.syncQueue.isDisposed) return ok()
      skippedLockedTransaction ||= !(await this.recordTransaction(transaction))
    }
    for (const accountTransactionId of toReconcile) {
      if (this.syncQueue.isDisposed) return ok()
      await this.retryReconciliation(accountTransactionId)
    }
    if (skippedLockedTransaction) {
      this.run.deps.console.debug(
        "Did not advance FIO sync pointer because a transaction was locked.",
        {
          accountId: this.plugin.accountId,
          pluginId: this.plugin.id,
        }
      )
      return ok()
    }
    await this.saveSyncPointer(period.to)
    this.run.deps.console.info("Finished FIO transaction sync.", {
      accountId: this.plugin.accountId,
      from: period.from,
      pluginId: this.plugin.id,
      recordedCount: toRecord.length,
      to: period.to,
    })
    return ok()
  }

  /**
   * Re-attempts reconciliation for a bank reference already recorded as an
   * account transaction, in case a prior sync recorded it but crashed or
   * failed before claiming it — `reconcileAccountTransaction` itself is the
   * guard against redoing work for one already claimed, at the cost of one
   * cheap read per already-recorded transaction in the sync window.
   */
  private async retryReconciliation(
    accountTransactionId: AccountTransactionId
  ): Promise<void> {
    const paymentId = await this.run.ok(
      reconcileAccountTransaction(accountTransactionId)
    )
    this.run.deps.console.debug("Re-checked FIO transaction reconciliation.", {
      accountId: this.plugin.accountId,
      accountTransactionId,
      paymentId,
      pluginId: this.plugin.id,
    })
  }

  private async recordTransaction(
    transaction: FioTransaction
  ): Promise<boolean> {
    return await this.run.deps.lockManager.request(
      `fio-transaction-${this.plugin.accountId}-${transaction.id}`,
      { ifAvailable: true },
      async (lock) => {
        if (lock === null) {
          this.run.deps.console.debug("Skipped locked FIO transaction.", {
            accountId: this.plugin.accountId,
            bankReference: transaction.id,
            pluginId: this.plugin.id,
          })
          return false
        }

        const bankReference = NonEmptyString255Schema.decode(transaction.id)

        const input = {
          accountId: this.plugin.accountId,
          amount: IntegerSchema.decode(transaction.amountMinor),
          currency: transaction.currency,
          occurredAt: TimestampMsSchema.decode(
            dateStringToDate(transaction.bookedDate).getTime()
          ),
          note: createTransactionNote(transaction),
          internalTransferGroupId: null,
          source: {
            deviceId: null,
            source: "auto" as const,
          },
          iban: {
            variableSymbol: transaction.variableSymbol,
            constantSymbol: transaction.constantSymbol,
            specificSymbol: transaction.specificSymbol,
            bankReference,
            recipientMessage: createRecipientMessage(transaction),
          },
        }
        const accountTransaction = computeAccountTransactionRows(
          input,
          this.run.deps.date.now()
        )
        const reconciliation = await this.run.deps.lockManager.request(
          SELF_PAY_ARRIVAL_LOCK,
          async () => {
            const loaded = await this.run.ok(
              loadAutomaticReconciliation(input, accountTransaction.id)
            )
            await runMutationWithCompletion((options) => {
              upsertAccountTransactionRows(
                this.run.deps.evolu,
                accountTransaction,
                { ...options, owner: this.run.deps.evoluOwner }
              )
              if (loaded !== null) {
                upsertAutomaticReconciliationRows(this.run.deps.evolu, loaded, {
                  ...options,
                  owner: this.run.deps.evoluOwner,
                })
              }
            })
            return loaded
          }
        )
        const accountTransactionId = accountTransaction.id
        this.run.deps.console.info("Created FIO account transaction.", {
          accountId: this.plugin.accountId,
          accountTransactionId,
          amount: transaction.amountMinor,
          bankReference,
          paymentId: reconciliation?.claim.paymentId ?? null,
          pluginId: this.plugin.id,
        })
        return true
      }
    )
  }

  private async getSyncPeriod(): Promise<{
    readonly from: DateString
    readonly to: DateString
  }> {
    const to = dateToDateString(this.run.deps.date.now())
    const [pointer] = await this.run.deps.evolu.loadQuery(
      fioPluginSyncPointerByPluginIdQuery(this.plugin.id)
    )
    const syncLookbackDays =
      this.plugin.syncLookbackDays ?? defaultFioPluginSyncLookbackDays
    const from =
      pointer?.lastSyncedDate === null || pointer?.lastSyncedDate === undefined
        ? getFioFirstSyncDate(this.run.deps.date.now())
        : dateToDateString(
            subDays(dateStringToDate(pointer.lastSyncedDate), syncLookbackDays)
          )

    this.run.deps.console.debug("Resolved FIO sync period.", {
      from,
      lastSyncedDate: pointer?.lastSyncedDate ?? null,
      pluginId: this.plugin.id,
      syncLookbackDays,
      to,
    })

    return { from, to }
  }

  private async getTransactionsToRecord(
    transactions: ReadonlyArray<FioTransaction>
  ): Promise<{
    readonly toRecord: ReadonlyArray<FioTransaction>
    readonly toReconcile: ReadonlyArray<AccountTransactionId>
  }> {
    const bankReferences = getUniqueBankReferences(transactions)
    if (bankReferences.length === 0) {
      this.run.deps.console.debug("No FIO transactions have bank references.", {
        accountId: this.plugin.accountId,
        pluginId: this.plugin.id,
        transactionCount: transactions.length,
      })
      return { toRecord: [], toReconcile: [] }
    }

    const existing = await this.run.deps.evolu.loadQuery(
      existingFioTransactionBankReferencesQuery({
        accountId: this.plugin.accountId,
        bankReferences,
      })
    )
    const existingAccountTransactionIdByBankReference = new Map(
      existing.map((transaction) => [
        transaction.bankReference,
        transaction.accountTransactionId,
      ])
    )
    const selectedBankReferences = new Set<string>()
    const selectedTransactions: FioTransaction[] = []

    for (const transaction of transactions) {
      const bankReference = NonEmptyString255Schema.decode(transaction.id)
      if (existingAccountTransactionIdByBankReference.has(bankReference))
        continue
      if (selectedBankReferences.has(bankReference)) continue

      selectedBankReferences.add(bankReference)
      selectedTransactions.push(transaction)
    }

    this.run.deps.console.debug("Filtered FIO transactions.", {
      accountId: this.plugin.accountId,
      downloadedCount: transactions.length,
      existingCount: existingAccountTransactionIdByBankReference.size,
      pluginId: this.plugin.id,
      selectedCount: selectedTransactions.length,
      uniqueBankReferenceCount: bankReferences.length,
    })

    return {
      toRecord: selectedTransactions,
      toReconcile: [...existingAccountTransactionIdByBankReference.values()],
    }
  }

  private async saveSyncPointer(lastSyncedDate: DateString): Promise<void> {
    await runMutationWithCompletion((options) =>
      this.run.deps.evolu.upsert(
        "fioPluginSyncPointer",
        removeUndefinedValues({
          id: this.plugin.id,
          lastSyncedDate,
        }),
        { ...options, owner: this.run.deps.evoluOwner }
      )
    )
    this.run.deps.console.debug("Saved FIO sync pointer.", {
      lastSyncedDate,
      pluginId: this.plugin.id,
    })
  }
}

const getFioFirstSyncDate = (now: Date): DateString => {
  return DateStringSchema.decode(
    format(subMonths(now, FIO_FIRST_SYNC_LOOKBACK_MONTHS), "yyyy-MM-dd")
  )
}

const getUniqueBankReferences = (
  transactions: ReadonlyArray<FioTransaction>
): ReadonlyArray<ReturnType<typeof NonEmptyString255Schema.decode>> => [
  ...new Set(
    transactions.map((transaction) =>
      NonEmptyString255Schema.decode(transaction.id)
    )
  ),
]

const hasFioTokens = (
  plugin: ActiveFioPlugin
): plugin is ActiveFioPluginWithTokens => plugin.tokens.length > 0

const areTokensEqual = (
  left: ReadonlyArray<FioPluginToken>,
  right: ReadonlyArray<FioPluginToken>
): boolean =>
  left.length === right.length &&
  left.every((token, index) => token.token === right[index]?.token)

const createRecipientMessage = ({ recipientMessage }: FioTransaction) => {
  const parsed = NonEmptyStringSchema.safeParse(recipientMessage)
  return parsed.success ? parsed.data : null
}

const createTransactionNote = (transaction: FioTransaction) => {
  const parts = [
    transaction.counterAccountName,
    transaction.recipientMessage,
    transaction.userIdentification,
    transaction.type,
  ].filter((part): part is string => part !== null && part.length > 0)

  if (parts.length === 0) return null

  return NonEmptyStringSchema.decode(parts.join(" | "))
}
