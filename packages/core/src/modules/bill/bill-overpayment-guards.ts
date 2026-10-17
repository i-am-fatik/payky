import { type Id, ok, type Task } from "@evolu/common"

import type { EvoluOwnerDep } from "../../deps.ts"
import type { AppSchema } from "../../evolu/schema.ts"
import { eetReportedGoodsQuery } from "../eet/eet-queries.ts"
import { overpaymentResolutionsQuery } from "../overpayment-resolution/overpayment-resolution-queries.ts"
import type { PaymentId } from "../payment/payment-types.ts"
import { overpaymentRefundsQuery } from "../refund/refund-queries.ts"
import type { EvoluDep } from "../shared/evolu-deps.ts"
import {
  firstWriteClocksQuery,
  mapFirstWriteClocks,
} from "../shared/evolu-history-queries.ts"
import { NonNegativeInteger } from "../shared/schema.ts"
import {
  overpaymentPaymentsQuery,
  overpaymentTransactionsQuery,
} from "./bill-coverage-queries.ts"
import {
  type BillNotFoundError,
  loadBillStatusSnapshot,
} from "./bill-guards.ts"
import {
  deriveReportedGoodsByPayment,
  toBillOverpaymentInput,
} from "./bill-overpayment-utils.ts"
import type { OverpaymentScope, SyncClockHex } from "./bill-types.ts"
import type { BillOverpaymentInput } from "./bill-utils.ts"

const loadFirstWriteClocks =
  <TId extends Id>(
    table: keyof typeof AppSchema,
    ids: ReadonlyArray<TId>,
    column?: string
  ): Task<ReadonlyMap<TId, SyncClockHex>, never, EvoluDep & EvoluOwnerDep> =>
  async (run) => {
    if (ids.length === 0) return ok(new Map())
    const { evolu, evoluOwner } = run.deps
    const rows = await evolu.loadQuery(
      firstWriteClocksQuery({ ownerId: evoluOwner.id, table, column, ids })
    )
    return ok(mapFirstWriteClocks(ids, rows))
  }

const loadOverpaymentTotal =
  (
    scope: OverpaymentScope,
    payments: ReadonlyArray<{
      readonly amount: NonNegativeInteger
      readonly tipAmount: NonNegativeInteger
    }>
  ): Task<
    { readonly billTotal: NonNegativeInteger; readonly isCanceled: boolean },
    BillNotFoundError,
    EvoluDep
  > =>
  async (run) => {
    if (scope.billId === undefined) {
      const payment = payments[0]
      return ok({
        billTotal: NonNegativeInteger(
          payment === undefined
            ? 0
            : Math.max(0, payment.amount - payment.tipAmount)
        ),
        isCanceled: false,
      })
    }
    const snapshot = await run(loadBillStatusSnapshot(scope.billId))
    if (!snapshot.ok) return snapshot
    return ok({
      billTotal: snapshot.value.billTotal,
      isCanceled: snapshot.value.status === "canceled",
    })
  }

export const loadOverpaymentInput =
  (
    scope: OverpaymentScope
  ): Task<BillOverpaymentInput, BillNotFoundError, EvoluDep & EvoluOwnerDep> =>
  async (run) => {
    const { evolu } = run.deps
    const [payments, transactions, refunds, resolutions] = await Promise.all([
      evolu.loadQuery(overpaymentPaymentsQuery(scope)),
      evolu.loadQuery(overpaymentTransactionsQuery(scope)),
      evolu.loadQuery(overpaymentRefundsQuery(scope)),
      evolu.loadQuery(overpaymentResolutionsQuery(scope)),
    ])
    const total = await run(loadOverpaymentTotal(scope, payments))
    if (!total.ok) return total

    const [claims, refundClocks, resolutionClocks, acknowledgements] =
      await Promise.all([
        run.ok(
          loadFirstWriteClocks(
            "reconciliationClaim",
            transactions.map(({ claimId }) => claimId)
          )
        ),
        run.ok(
          loadFirstWriteClocks(
            "refund",
            refunds.map(({ id }) => id)
          )
        ),
        run.ok(
          loadFirstWriteClocks(
            "overpaymentResolution",
            resolutions.map(({ id }) => id)
          )
        ),
        run.ok(
          loadFirstWriteClocks(
            "payment",
            payments
              .filter(
                ({ excessAcknowledgedAt }) => excessAcknowledgedAt !== null
              )
              .map(({ id }) => id),
            "excessAcknowledgedAt"
          )
        ),
      ])

    return ok(
      toBillOverpaymentInput(
        { ...total.value, payments, transactions, refunds, resolutions },
        {
          claims,
          refunds: refundClocks,
          resolutions: resolutionClocks,
          acknowledgements,
        }
      )
    )
  }

export const loadReportedGoodsByPayment =
  (
    scope: OverpaymentScope
  ): Task<ReadonlyMap<PaymentId, NonNegativeInteger>, never, EvoluDep> =>
  async (run) =>
    ok(
      deriveReportedGoodsByPayment(
        await run.deps.evolu.loadQuery(eetReportedGoodsQuery(scope))
      )
    )
