import {
  type Id,
  idToIdBytes,
  kyselySql,
  type OwnerId,
  ownerIdToOwnerIdBytes,
} from "@evolu/common"
import { bytesToHex } from "@noble/hashes/utils.js"

import { type AppSchema, createQuery } from "../../evolu/schema.ts"

export const firstWriteClocksQuery = ({
  ownerId,
  table,
  column,
  ids,
}: {
  readonly ownerId: OwnerId
  readonly table: keyof typeof AppSchema
  readonly column?: string
  readonly ids: ReadonlyArray<Id>
}) =>
  createQuery((db) =>
    db
      .selectFrom(
        kyselySql<{
          idHex: string
          clockHex: string
        }>`(select hex("id") as "idHex", hex(min("timestamp")) as "clockHex" from "evolu_history" where "ownerId" = ${ownerIdToOwnerIdBytes(ownerId)} and "table" = ${table} and ${column === undefined ? kyselySql`1` : kyselySql`"column" = ${column}`} and "id" in (${kyselySql.join(ids.map(idToIdBytes))}) group by "id")`.as(
          "firstWrite"
        )
      )
      .select(["firstWrite.idHex", "firstWrite.clockHex"])
  )

export const mapFirstWriteClocks = <TId extends Id>(
  ids: ReadonlyArray<TId>,
  rows: ReadonlyArray<{ readonly idHex: string; readonly clockHex: string }>
): ReadonlyMap<TId, string> => {
  const idByHex = new Map(
    ids.map((id) => [bytesToHex(idToIdBytes(id)).toUpperCase(), id])
  )
  return new Map(
    rows.flatMap((row) => {
      const id = idByHex.get(row.idHex)
      return id === undefined ? [] : [[id, row.clockHex] as const]
    })
  )
}
