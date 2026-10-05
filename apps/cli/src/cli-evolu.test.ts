import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type CreateSqliteDriver, createRun, Port } from "@evolu/common"
import {
  createBetterSqliteDriver,
  createRelay,
  createRelayDeps,
} from "@evolu/nodejs"
import { createQuery } from "@payky/core/evolu/schema"
import {
  createMasterKey,
  deriveTableSelfPayRoot,
} from "@payky/core/modules/shared/key-derivation"
import {
  NonEmptyString255,
  NonNegativeInteger,
  PositiveInteger,
} from "@payky/core/modules/shared/schema"
import { describe, expect, test, vi } from "vitest"
import { createCliEvolu } from "./cli-evolu.ts"

const createMemorySqliteDriver: CreateSqliteDriver = (name) =>
  createBetterSqliteDriver(name, { mode: "memory" })

const tableNamesQuery = createQuery((db) =>
  db.selectFrom("table").select("name")
)

describe("createCliEvolu", () => {
  test("syncs two databases opened with one master key through a relay", async () => {
    await using relayRun = createRun({
      ...createRelayDeps(),
      createSqliteDriver: createMemorySqliteDriver,
    })
    await using relay = await relayRun.ok(
      createRelay({ port: Port.orThrow(0), isOwnerWithinQuota: () => true })
    )
    const account = {
      masterKey: createMasterKey(),
      transports: [
        { type: "WebSocket", url: `ws://localhost:${relay.port}` },
      ] as const,
    }
    await using writer = await createCliEvolu("memory", account)
    await using reader = await createCliEvolu("memory", account)

    writer.evolu.insert("table", {
      deviceId: null,
      name: NonEmptyString255("Terrace"),
      seatCount: PositiveInteger(4),
      code: NonEmptyString255("T1"),
      sortOrder: NonNegativeInteger(0),
    })

    expect(reader.evolu.appOwner.id).toBe(writer.evolu.appOwner.id)
    await vi.waitFor(
      async () => {
        expect(await reader.evolu.loadQuery(tableNamesQuery)).toEqual([
          { name: "Terrace" },
        ])
      },
      { timeout: 10_000, interval: 100 }
    )
  })

  test("keeps its database file readable only by its user", async () => {
    const directory = mkdtempSync(join(tmpdir(), "payky-cli-evolu-"))
    const databasePath = join(directory, "payky.db")
    writeFileSync(databasePath, "", { mode: 0o644 })
    try {
      await using _cliEvolu = await createCliEvolu(databasePath)

      expect(statSync(databasePath).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("carries the self-pay root of its account, and none without one", async () => {
    const masterKey = createMasterKey()
    await using withAccount = await createCliEvolu("memory", {
      masterKey,
      transports: [],
    })
    await using withoutAccount = await createCliEvolu("memory")

    expect(withAccount.tableSelfPayRoot).toEqual(
      deriveTableSelfPayRoot(masterKey)
    )
    expect(withoutAccount.tableSelfPayRoot).toBeUndefined()
  })
})
