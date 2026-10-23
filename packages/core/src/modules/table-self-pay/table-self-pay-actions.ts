import {
  createIdFromString,
  err,
  type MutationOptions,
  ok,
  type Result,
  sqliteFalse,
  sqliteTrue,
  type Task,
} from "@evolu/common"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js"
import { subDays } from "date-fns"
import { z } from "zod"

import type {
  DateDep,
  DeviceIdDep,
  EvoluOwnerDep,
  SelfPayDefaultRelaysDep,
  TableSelfPayRootDep,
} from "../../deps.ts"
import { defineError } from "../../error.ts"
import type {
  SparkPaymentWallet,
  SparkWalletDep,
} from "../../spark/spark-wallet.ts"
import { jsonCodec } from "../../zod-utils.ts"
import {
  fiatBankAccountQuery,
  sparkAccountQuery,
} from "../account/account-queries.ts"
import { selfPaySettingsQuery } from "../app-settings/app-settings-queries.ts"
import type { BillId } from "../bill/bill-types.ts"
import type { DeviceId } from "../device/device-types.ts"
import { activeFioPluginsQuery } from "../fio-plugin/fio-plugin-queries.ts"
import type { EvoluDep } from "../shared/evolu-deps.ts"
import { runMutationWithCompletion } from "../shared/evolu-utils.ts"
import { deriveSelfPaySelectionKey } from "../shared/key-derivation.ts"
import {
  type FiatCurrency,
  NonEmptyString255,
  NonEmptyStringSchema,
  NonNegativeInteger,
  PositiveInteger,
  TimestampMs,
  type WssUrl,
} from "../shared/schema.ts"
import {
  findOfferedSelfPayReferences,
  projectTableSelfPayView,
  type SelfPayInstructions,
  selfPayConfirmationsEndedAfter,
} from "./table-self-pay-projection-utils.ts"
import {
  expiredSelfPayViewVersionsQuery,
  openBillIdsQuery,
  type SelfPayTableRow,
  selfPayRelaysQuery,
  selfPayViewPublicationByIdQuery,
  selfPayViewVersionsByBillIdQuery,
  tableSelfPayBillsQuery,
  tableSelfPayConfirmationsQuery,
  tableSelfPayVersionQuery,
  tableSelfPayViewVersionIdsQuery,
} from "./table-self-pay-queries.ts"
import {
  pickSelfPayAccounts,
  SelfPayPublishResultJson,
} from "./table-self-pay-reach-utils.ts"
import type { SelfPayReference } from "./table-self-pay-reference-utils.ts"
import {
  activeSelfPayRelays,
  listSelfPayRelays,
} from "./table-self-pay-relay-utils.ts"
import type { SelfPayShareBill } from "./table-self-pay-share-utils.ts"
import {
  createDisabledSelfPayView,
  SelfPayShareBillSchema,
  type SelfPayView,
} from "./table-self-pay-view-utils.ts"

const ENDED_BILL_RETENTION_DAYS = 7

const SelfPayShareBillJson = jsonCodec(SelfPayShareBillSchema)

export const upsertBillSelfPayReferences = (
  evolu: EvoluDep["evolu"],
  references: ReadonlyArray<{
    readonly billId: BillId
    readonly reference: SelfPayReference
  }>,
  options: MutationOptions
): void => {
  for (const { billId, reference } of references) {
    evolu.upsert("billSelfPayReference", { id: billId, reference }, options)
  }
}

const createSparkWalletPublicError = defineError("SparkWalletPublic")()
type SparkWalletPublicError = ReturnType<typeof createSparkWalletPublicError>

const makeSparkWalletPrivate = async (
  wallet: SparkPaymentWallet
): Promise<Result<void, SparkWalletPublicError>> => {
  const settings = await wallet.getWalletSettings()
  if (settings?.privateEnabled === true) return ok()
  const updated = await wallet.setPrivacyEnabled(true)
  return updated?.privateEnabled === true
    ? ok()
    : err(createSparkWalletPublicError())
}

const prepareSelfPayInstructions =
  (): Task<
    SelfPayInstructions,
    never,
    EvoluDep & SparkWalletDep & TableSelfPayRootDep
  > =>
  async (run) => {
    const [[bankAccount], [sparkAccount], activeFioPlugins, [settings]] =
      await Promise.all(
        run.deps.evolu.loadQueries([
          fiatBankAccountQuery,
          sparkAccountQuery,
          activeFioPluginsQuery,
          selfPaySettingsQuery,
        ])
      )
    const payee = settings?.selfPayGuestName ?? null
    const accounts = pickSelfPayAccounts({
      bankAccount,
      sparkAccount,
      activeFioPlugins,
    })
    const bank =
      accounts.bank === null
        ? null
        : {
            iban: accounts.bank.iban,
            accountName: payee ?? "",
            currency: accounts.bank.currency,
            qrFormat: accounts.bank.defaultQrFormat ?? "spayd",
          }
    let lightning: SelfPayInstructions["lightning"] = null
    if (accounts.spark !== null) {
      try {
        await using wallet = await run.deps.sparkWallet.create(
          accounts.spark.secret
        )
        const privacy = await makeSparkWalletPrivate(wallet)
        if (privacy.ok) {
          lightning = {
            identityPublicKey: await wallet.getIdentityPublicKey(),
          }
        } else {
          run.deps.console.warn(
            "Offered no Lightning while the Spark wallet stays public."
          )
        }
      } catch {
        run.deps.console.warn(
          "Offered no Lightning while Spark is unreachable."
        )
      }
    }

    return ok({
      payee,
      bank,
      lightning,
      selectionKey: bytesToHex(
        deriveSelfPaySelectionKey(run.deps.tableSelfPayRoot)
      ),
    })
  }

const createSelfPayViewVersionRow = (
  billId: BillId,
  bill: SelfPayShareBill
) => {
  const content = z.encode(SelfPayShareBillJson, bill)
  return {
    id: createIdFromString<"SelfPayViewVersion">(
      `selfPayViewVersion:${billId}:${content}`
    ),
    billId,
    content: NonEmptyStringSchema.decode(content),
  }
}

type SelfPayViewVersionWrite = ReturnType<typeof createSelfPayViewVersionRow>

const upsertSelfPayViewVersions = (
  evolu: EvoluDep["evolu"],
  versions: ReadonlyArray<SelfPayViewVersionWrite>,
  options: MutationOptions
): void => {
  for (const version of versions) {
    evolu.upsert("selfPayViewVersion", version, options)
  }
}

const parseSelfPayViewVersion = (content: string): SelfPayShareBill | null => {
  const parsed = z.safeDecode(SelfPayShareBillJson, content)
  return parsed.success ? parsed.data : null
}

export const loadSelfPayViewVersions =
  (billId: BillId): Task<ReadonlyArray<SelfPayShareBill>, never, EvoluDep> =>
  async (run) => {
    const rows = await run.deps.evolu.loadQuery(
      selfPayViewVersionsByBillIdQuery(billId)
    )
    return ok(
      rows.flatMap(({ content }) => {
        const version = parseSelfPayViewVersion(content)
        return version === null ? [] : [version]
      })
    )
  }

export const dropExpiredSelfPayViewVersions =
  (): Task<number, never, EvoluDep & EvoluOwnerDep & DateDep> =>
  async (run) => {
    const { evolu, evoluOwner } = run.deps
    const expired = await evolu.loadQuery(
      expiredSelfPayViewVersionsQuery(
        TimestampMs(
          subDays(run.deps.date.now(), ENDED_BILL_RETENTION_DAYS).getTime()
        )
      )
    )
    if (expired.length === 0) return ok(0)

    await runMutationWithCompletion((options) => {
      for (const { id } of expired) {
        evolu.update(
          "selfPayViewVersion",
          { id, isDeleted: sqliteTrue },
          { ...options, owner: evoluOwner }
        )
      }
    })
    return ok(expired.length)
  }

interface TableSelfPayViewSnapshot {
  readonly view: SelfPayView
  readonly version: number
  readonly currencies: ReadonlySet<FiatCurrency>
  readonly references: ReadonlyArray<{
    readonly billId: BillId
    readonly reference: SelfPayReference
  }>
  readonly versions: ReadonlyArray<SelfPayViewVersionWrite>
}

export const loadTableSelfPayView =
  (
    table: SelfPayTableRow
  ): Task<
    TableSelfPayViewSnapshot,
    never,
    EvoluDep & SparkWalletDep & TableSelfPayRootDep
  > =>
  async (run) => {
    const [bills, openBills, [change], storedVersions] = await Promise.all(
      run.deps.evolu.loadQueries([
        tableSelfPayBillsQuery(table.id),
        openBillIdsQuery,
        tableSelfPayVersionQuery(table.id),
        tableSelfPayViewVersionIdsQuery(table.id),
      ])
    )
    const version = Math.max(
      0,
      ...[change?.createdAt, change?.updatedAt].flatMap((changedAt) =>
        changedAt === null || changedAt === undefined
          ? []
          : [Math.floor(Date.parse(changedAt) / 1000)]
      )
    )
    if (table.selfPayEnabled !== sqliteTrue) {
      return ok({
        view: createDisabledSelfPayView(table.name),
        version,
        currencies: new Set(),
        references: [],
        versions: [],
      })
    }

    const [instructions, confirmations] = await Promise.all([
      run.ok(prepareSelfPayInstructions()),
      run.deps.evolu.loadQuery(
        tableSelfPayConfirmationsQuery(
          table.id,
          selfPayConfirmationsEndedAfter(version)
        )
      ),
    ])
    const offered = findOfferedSelfPayReferences(openBills)
    const view = projectTableSelfPayView({
      tableName: table.name,
      bills,
      confirmations,
      offered,
      instructions,
    })
    const billIdByReference = new Map(
      [...offered].map(([billId, reference]) => [reference, billId])
    )
    const storedVersionIds = new Set(storedVersions.map(({ id }) => id))
    return ok({
      view,
      version,
      currencies: new Set(bills.map(({ currency }) => currency)),
      references: bills.flatMap(({ id, deviceId, reference }) => {
        const offeredReference = offered.get(id)
        return deviceId !== null &&
          reference === null &&
          offeredReference !== undefined
          ? [{ billId: id, reference: offeredReference }]
          : []
      }),
      versions: view.bills.flatMap((bill) => {
        const billId = billIdByReference.get(bill.reference)
        if (billId === undefined) return []
        const row = createSelfPayViewVersionRow(billId, bill)
        return storedVersionIds.has(row.id) ? [] : [row]
      }),
    })
  }

export const saveTableSelfPayViewSnapshot =
  ({
    references,
    versions,
  }: TableSelfPayViewSnapshot): Task<void, never, EvoluDep & EvoluOwnerDep> =>
  async (run) => {
    if (references.length === 0 && versions.length === 0) return ok()
    await runMutationWithCompletion((options) => {
      const owned = { ...options, owner: run.deps.evoluOwner }
      upsertBillSelfPayReferences(run.deps.evolu, references, owned)
      upsertSelfPayViewVersions(run.deps.evolu, versions, owned)
    })
    return ok()
  }

const selfPayViewPublicationId = (deviceId: DeviceId, tag: string) =>
  createIdFromString<"SelfPayViewPublication">(
    `selfPayViewPublication:${deviceId}:${tag}`
  )

export const loadSelfPayViewPublishedAt =
  (tag: string): Task<number | null, never, EvoluDep & DeviceIdDep> =>
  async (run) => {
    const [publication] = await run.deps.evolu.loadQuery(
      selfPayViewPublicationByIdQuery(
        selfPayViewPublicationId(run.deps.deviceId, tag)
      )
    )
    return ok(publication?.eventCreatedAt ?? null)
  }

export const saveSelfPayViewPublishResult =
  ({
    tag,
    createdAt,
    version,
    content,
    relays,
  }: {
    readonly tag: string
    readonly createdAt: number
    readonly version: number
    readonly content: string
    readonly relays: ReadonlyArray<{
      readonly url: WssUrl
      readonly accepted: boolean
    }>
  }): Task<void, never, EvoluDep & EvoluOwnerDep & DeviceIdDep & DateDep> =>
  async (run) => {
    const { evolu, evoluOwner, deviceId, date } = run.deps
    const row = {
      id: selfPayViewPublicationId(deviceId, tag),
      tag: NonEmptyString255(tag),
      lastPublishJson: z.encode(SelfPayPublishResultJson, {
        at: TimestampMs(date.now().getTime()),
        version: NonNegativeInteger(version),
        contentHash: bytesToHex(sha256(utf8ToBytes(content))),
        relays,
      }),
    }
    await runMutationWithCompletion((options) => {
      const owned = { ...options, owner: evoluOwner }
      if (relays.some(({ accepted }) => accepted)) {
        evolu.upsert(
          "selfPayViewPublication",
          { ...row, eventCreatedAt: PositiveInteger(createdAt) },
          owned
        )
      } else {
        evolu.update("selfPayViewPublication", row, owned)
      }
    })
    return ok()
  }

export const loadActiveSelfPayRelays =
  (): Task<ReadonlyArray<WssUrl>, never, EvoluDep & SelfPayDefaultRelaysDep> =>
  async (run) => {
    const rows = await run.deps.evolu.loadQuery(selfPayRelaysQuery)
    return ok(
      activeSelfPayRelays(
        listSelfPayRelays(run.deps.selfPayDefaultRelays, rows)
      )
    )
  }

export const setSelfPayRelayActive =
  ({
    url,
    isActive,
  }: {
    readonly url: WssUrl
    readonly isActive: boolean
  }): Task<void, never, EvoluDep & EvoluOwnerDep> =>
  async (run) => {
    const { evolu, evoluOwner } = run.deps
    await runMutationWithCompletion((options) =>
      evolu.upsert(
        "selfPayRelay",
        {
          id: createIdFromString<"SelfPayRelay">(url),
          url,
          isActive: isActive ? sqliteTrue : sqliteFalse,
        },
        { ...options, owner: evoluOwner }
      )
    )
    return ok()
  }
