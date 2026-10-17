import type { Id } from "@evolu/common"
import type { AppSchema } from "@payky/core/evolu/schema"
import {
  overpaymentPaymentsQuery,
  overpaymentTransactionsQuery,
} from "@payky/core/modules/bill/bill-coverage-queries"
import { toBillOverpaymentInput } from "@payky/core/modules/bill/bill-overpayment-utils"
import type { OverpaymentScope } from "@payky/core/modules/bill/bill-types"
import type { BillOverpaymentInput } from "@payky/core/modules/bill/bill-utils"
import { deriveBillSummaryTotal } from "@payky/core/modules/bill-line/bill-line-utils"
import { overpaymentResolutionsQuery } from "@payky/core/modules/overpayment-resolution/overpayment-resolution-queries"
import { overpaymentRefundsQuery } from "@payky/core/modules/refund/refund-queries"
import {
  firstWriteClocksQuery,
  mapFirstWriteClocks,
} from "@payky/core/modules/shared/evolu-history-queries"
import { NonNegativeInteger } from "@payky/core/modules/shared/schema"
import { useMemo } from "react"
import { useBillLineSummaries } from "@/features/shared/use-bill-line-summaries.ts"
import { useBillStatus } from "@/features/shared/use-bill-status.ts"
import { useEvolu } from "@/hooks/use-evolu.ts"
import {
  useEvoluQuery,
  useOptionalEvoluQuery,
} from "@/hooks/use-evolu-query.ts"

const useFirstWriteClocks = <TId extends Id>(
  table: keyof typeof AppSchema,
  ids: ReadonlyArray<TId>,
  column?: string
) => {
  const evolu = useEvolu()
  const { data } = useOptionalEvoluQuery(
    ids.length === 0
      ? null
      : firstWriteClocksQuery({
          ownerId: evolu.appOwner.id,
          table,
          column,
          ids,
        })
  )
  return useMemo(() => mapFirstWriteClocks(ids, data), [ids, data])
}

export function useOverpaymentInput(
  scope: OverpaymentScope
): BillOverpaymentInput | undefined {
  const { billId } = scope
  const { data: payments } = useEvoluQuery(overpaymentPaymentsQuery(scope))
  const { data: transactions } = useEvoluQuery(
    overpaymentTransactionsQuery(scope)
  )
  const { data: refunds } = useEvoluQuery(overpaymentRefundsQuery(scope))
  const { data: resolutions } = useEvoluQuery(
    overpaymentResolutionsQuery(scope)
  )
  const billStatus = useBillStatus(billId)
  const summaries = useBillLineSummaries(billId)

  const claims = useFirstWriteClocks(
    "reconciliationClaim",
    useMemo(() => transactions.map(({ claimId }) => claimId), [transactions])
  )
  const refundClocks = useFirstWriteClocks(
    "refund",
    useMemo(() => refunds.map(({ id }) => id), [refunds])
  )
  const resolutionClocks = useFirstWriteClocks(
    "overpaymentResolution",
    useMemo(() => resolutions.map(({ id }) => id), [resolutions])
  )
  const acknowledgements = useFirstWriteClocks(
    "payment",
    useMemo(
      () =>
        payments
          .filter(({ excessAcknowledgedAt }) => excessAcknowledgedAt !== null)
          .map(({ id }) => id),
      [payments]
    ),
    "excessAcknowledgedAt"
  )

  return useMemo(() => {
    const payment = payments[0]
    const total =
      billId === undefined
        ? payment === undefined
          ? undefined
          : {
              billTotal: NonNegativeInteger(
                Math.max(0, payment.amount - payment.tipAmount)
              ),
              isCanceled: false,
            }
        : billStatus === undefined
          ? undefined
          : {
              billTotal: deriveBillSummaryTotal(summaries),
              isCanceled: billStatus.status === "canceled",
            }
    if (total === undefined) return undefined
    return toBillOverpaymentInput(
      { ...total, payments, transactions, refunds, resolutions },
      {
        claims,
        refunds: refundClocks,
        resolutions: resolutionClocks,
        acknowledgements,
      }
    )
  }, [
    billId,
    billStatus,
    summaries,
    payments,
    transactions,
    refunds,
    resolutions,
    claims,
    refundClocks,
    resolutionClocks,
    acknowledgements,
  ])
}
