import { type KyselyNotNull, sqliteTrue } from "@evolu/common"

import { createQuery } from "../../evolu/schema.ts"
import type { OverpaymentScope } from "../bill/bill-types.ts"
import type { OverpaymentResolutionId } from "./overpayment-resolution-types.ts"

const overpaymentResolutionColumns = [
  "overpaymentResolution.id",
  "overpaymentResolution.paymentId",
  "overpaymentResolution.deviceId",
  "overpaymentResolution.kind",
  "overpaymentResolution.amount",
  "overpaymentResolution.currency",
  "overpaymentResolution.knownTransactionIdsJson",
  "overpaymentResolution.withdrawnId",
  "overpaymentResolution.createdAt",
] as const

type OverpaymentResolutionRequiredColumns = {
  paymentId: KyselyNotNull
  kind: KyselyNotNull
  amount: KyselyNotNull
  currency: KyselyNotNull
  knownTransactionIdsJson: KyselyNotNull
}

export const overpaymentResolutionsQuery = (scope: OverpaymentScope) =>
  createQuery((db) =>
    db
      .selectFrom("overpaymentResolution")
      .innerJoin("payment", "payment.id", "overpaymentResolution.paymentId")
      .select(overpaymentResolutionColumns)
      .where((eb) =>
        scope.billId === undefined
          ? eb("payment.id", "=", scope.paymentId)
          : eb("payment.billId", "=", scope.billId)
      )
      .where("payment.isDeleted", "is not", sqliteTrue)
      .where("overpaymentResolution.isDeleted", "is not", sqliteTrue)
      .where("overpaymentResolution.paymentId", "is not", null)
      .where("overpaymentResolution.kind", "is not", null)
      .where("overpaymentResolution.amount", "is not", null)
      .where("overpaymentResolution.currency", "is not", null)
      .where("overpaymentResolution.knownTransactionIdsJson", "is not", null)
      .orderBy("overpaymentResolution.createdAt")
      .orderBy("overpaymentResolution.id")
      .$narrowType<OverpaymentResolutionRequiredColumns>()
  )

export const overpaymentResolutionByIdQuery = (id: OverpaymentResolutionId) =>
  createQuery((db) =>
    db
      .selectFrom("overpaymentResolution")
      .select([
        "overpaymentResolution.id",
        "overpaymentResolution.paymentId",
        "overpaymentResolution.kind",
        "overpaymentResolution.currency",
      ])
      .where("overpaymentResolution.id", "=", id)
      .where("overpaymentResolution.isDeleted", "is not", sqliteTrue)
      .where("overpaymentResolution.paymentId", "is not", null)
      .where("overpaymentResolution.kind", "is not", null)
      .where("overpaymentResolution.currency", "is not", null)
      .$narrowType<{
        paymentId: KyselyNotNull
        kind: KyselyNotNull
        currency: KyselyNotNull
      }>()
  )

export const withdrawalsOfOverpaymentResolutionQuery = (
  id: OverpaymentResolutionId
) =>
  createQuery((db) =>
    db
      .selectFrom("overpaymentResolution")
      .select(["overpaymentResolution.id"])
      .where("overpaymentResolution.withdrawnId", "=", id)
      .where("overpaymentResolution.kind", "=", "withdrawal")
      .where("overpaymentResolution.isDeleted", "is not", sqliteTrue)
  )
