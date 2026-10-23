import { testCreateConsole, testCreateRun } from "@evolu/common"
import { createNostrRelayClient } from "../../integrations/nostr/nostr-relay-client.ts"
import { createFakeNostrRelay } from "../../integrations/nostr/nostr-relay-test-fixtures.ts"
import { createInProcessLockManager } from "../../runtime/in-process-lock-manager.ts"
import { createTestDateDep } from "../../testing/date-dep.ts"
import { createEvoluTest } from "../../testing/evolu.ts"
import { createAccount } from "../account/account-actions.ts"
import { addManualAmountToBill, createBill } from "../bill/bill-actions.ts"
import type { BillId } from "../bill/bill-types.ts"
import type { DeviceId } from "../device/device-types.ts"
import {
  createRowId,
  runMutationWithCompletion,
} from "../shared/evolu-utils.ts"
import {
  deriveTableSelfPayRoot,
  MasterKey,
  SparkSecret,
} from "../shared/key-derivation.ts"
import {
  type FiatCurrency,
  IbanSchema,
  NonEmptyString255,
  NonNegativeInteger,
  PositiveInteger,
  WssUrl,
} from "../shared/schema.ts"
import { createTableAtEnd } from "../table/table-actions.ts"
import type { TableId } from "../table/table-types.ts"
import {
  loadTableSelfPayView,
  saveTableSelfPayViewSnapshot,
  upsertBillSelfPayReferences,
} from "./table-self-pay-actions.ts"
import { selfPayTablesQuery } from "./table-self-pay-queries.ts"
import {
  deriveBillSelfPayReference,
  type SelfPayReference,
} from "./table-self-pay-reference-utils.ts"

export const selfPayTestMasterKey = MasterKey(
  "000102030405060708090a0b0c0d0e0f"
)

export const selfPayTestRoot = deriveTableSelfPayRoot(selfPayTestMasterKey)

const selfPayTestNow = new Date("2026-06-05T12:00:00.000Z")

export const createSelfPayTestContext = async ({
  now = selfPayTestNow,
}: {
  readonly now?: Date
} = {}) => {
  const testEvolu = await createEvoluTest()
  const { evolu } = testEvolu
  const clock = createTestDateDep(now)
  const relay = createFakeNostrRelay()
  const deps = {
    evolu,
    evoluOwner: evolu.appOwner,
    date: clock.date,
    tableSelfPayRoot: selfPayTestRoot,
    selfPayDefaultRelays: [WssUrl("wss://relay.test")],
    nostrRelayClient: createNostrRelayClient({
      createSocket: relay.createSocket,
    }),
    console: testCreateConsole(),
    lockManager: createInProcessLockManager(),
    sparkWallet: {
      create: async () => {
        throw new Error("Spark is unreachable.")
      },
    },
  }
  const deviceId = createRowId<"Device">()

  await using run = testCreateRun(deps)
  const ibanAccountId = await run.ok(
    createAccount({
      deviceId: null,
      name: NonEmptyString255("Bistro account"),
      iban: {
        iban: IbanSchema.decode("CZ6508000000192000145399"),
        currency: "CZK",
      },
    })
  )
  const sparkAccountId = await run.ok(
    createAccount({
      deviceId: null,
      name: NonEmptyString255("Bistro wallet"),
      spark: { secret: SparkSecret("42373a7543db65ae0228ead6c9cbffcc") },
    })
  )
  const tableId = await run.ok(
    createTableAtEnd({
      deviceId,
      name: NonEmptyString255("Table 3"),
      seatCount: PositiveInteger(4),
      selfPayEnabled: 1,
    })
  )

  return {
    deps,
    clock,
    relay,
    deviceId,
    ibanAccountId,
    sparkAccountId,
    tableId,
    [Symbol.asyncDispose]: () => testEvolu[Symbol.asyncDispose](),
  }
}

export type SelfPayTestContext = Awaited<
  ReturnType<typeof createSelfPayTestContext>
>

export const openSelfPayBill = async (
  context: SelfPayTestContext,
  {
    lines,
    tableId = context.tableId,
    deviceId = context.deviceId,
    currency = "CZK",
  }: {
    readonly lines: ReadonlyArray<{
      readonly name: string
      readonly amount: number
    }>
    readonly tableId?: TableId
    readonly deviceId?: DeviceId | null
    readonly currency?: FiatCurrency
  }
): Promise<{
  readonly billId: BillId
  readonly reference: SelfPayReference
}> => {
  await using run = testCreateRun(context.deps)
  const billId = await run.ok(
    createBill({
      deviceId,
      displayNumber: PositiveInteger(1),
      label: null,
      tableId,
      currency,
    })
  )
  for (const { name, amount } of lines) {
    await run.orThrow(
      addManualAmountToBill({
        billId,
        deviceId,
        totalAmount: NonNegativeInteger(amount),
        name: NonEmptyString255(name),
        currency,
      })
    )
  }
  const reference = deriveBillSelfPayReference(billId)
  await runMutationWithCompletion((options) =>
    upsertBillSelfPayReferences(context.deps.evolu, [{ billId, reference }], {
      ...options,
      owner: context.deps.evoluOwner,
    })
  )
  return { billId, reference }
}

export const loadSelfPayTestView = async (
  context: SelfPayTestContext,
  tableId: TableId = context.tableId
) => {
  const tables = await context.deps.evolu.loadQuery(selfPayTablesQuery)
  const table = tables.find(({ id }) => id === tableId)
  if (table === undefined) throw new Error("Expected the self-pay table.")
  await using run = testCreateRun(context.deps)
  return await run.ok(loadTableSelfPayView(table))
}

export const publishSelfPayTestView = async (
  context: SelfPayTestContext,
  tableId: TableId = context.tableId
) => {
  const snapshot = await loadSelfPayTestView(context, tableId)
  await using run = testCreateRun(context.deps)
  await run.ok(saveTableSelfPayViewSnapshot(snapshot))
  return snapshot
}
