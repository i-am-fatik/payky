import { testCreateRun } from "@evolu/common"
import { testSyncedAppOwner } from "@payky/core/testing/app-owner-sync"
import { createEvoluTest } from "@payky/core/testing/evolu"
import { createCommand } from "commander"
import { afterEach, describe, expect, test } from "vitest"

import { registerBackgroundJobsCommand } from "./cli-background-jobs.ts"

afterEach(() => {
  process.exitCode = undefined
})

describe("background-jobs run", () => {
  test("without a recovery phrase, says it needs one and returns instead of exiting", async () => {
    await using testEvolu = await createEvoluTest()
    const { evolu } = testEvolu
    await using run = testCreateRun({
      evolu,
      evoluOwner: evolu.appOwner,
      ...testSyncedAppOwner,
      databasePath: "payky.db",
    })
    const program = createCommand()
    registerBackgroundJobsCommand(program)(run)

    await program.parseAsync(["background-jobs", "run"], { from: "user" })

    expect(run.deps.console.getEntriesSnapshot()).toMatchObject([
      {
        method: "error",
        args: [
          "Background jobs run as a device of an account. Set PAYKY_RECOVERY_MNEMONIC.",
        ],
      },
    ])
    expect(process.exitCode).toBe(1)
  })
})
