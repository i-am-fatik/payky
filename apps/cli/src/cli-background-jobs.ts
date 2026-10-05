import { type ConsoleDep, createConsole, ok, type Task } from "@evolu/common"
import { runMain } from "@evolu/nodejs"
import { nativeBackgroundJobs } from "@payky/core/background-jobs/background-jobs"
import { runBackgroundJobs } from "@payky/core/background-jobs/run-background-jobs"
import {
  createDateDep,
  type EvoluOwnerDep,
  type TableSelfPayRootDep,
} from "@payky/core/deps"
import { createEetApiDep } from "@payky/core/integrations/eet/eet-client"
import { createNostrRelayClient } from "@payky/core/integrations/nostr/nostr-relay-client"
import { createYadioApiDep } from "@payky/core/integrations/yadio/yadio-client"
import type { EvoluDep } from "@payky/core/modules/shared/evolu-deps"
import { createInProcessLockManager } from "@payky/core/runtime/in-process-lock-manager"
import { createSparkWalletDep } from "@payky/core/spark/spark-wallet"
import { type Command, createCommand } from "commander"
import { loadOrCreateCliDeviceId, registerCliDevice } from "./cli-device.ts"
import { cliEnv } from "./cli-env.ts"
import { printCliError } from "./cli-errors.ts"
import type { CliDatabasePathDep } from "./cli-evolu.ts"
import { createFetchDep } from "./fetch.ts"

export const registerBackgroundJobsCommand =
  (
    program: Command
  ): Task<
    void,
    never,
    EvoluDep &
      EvoluOwnerDep &
      ConsoleDep &
      CliDatabasePathDep &
      Partial<TableSelfPayRootDep>
  > =>
  (run) => {
    const { evolu, evoluOwner, databasePath, tableSelfPayRoot } = run.deps

    const backgroundJobsCommand = createCommand("background-jobs").description(
      "Run Payky background workers."
    )

    backgroundJobsCommand.addCommand(
      createCommand("run")
        .description(
          "Run every background job a native device runs, as a device of the account, until shutdown."
        )
        .action(async () => {
          if (tableSelfPayRoot === undefined) {
            printCliError(
              run.deps.console,
              "Background jobs run as a device of an account. Set PAYKY_RECOVERY_MNEMONIC."
            )
            return
          }
          const deviceId = loadOrCreateCliDeviceId(databasePath)
          const appConsole = createConsole()
          const dateDep = createDateDep()
          const fetchDep = createFetchDep()
          await runMain({
            console: appConsole,
            evolu,
            evoluOwner,
            deviceId,
            tableSelfPayRoot,
            ...dateDep,
            ...fetchDep,
            connectivity: { onOnline: () => () => undefined },
            ...createEetApiDep({ ...dateDep, ...fetchDep }),
            ...createSparkWalletDep(),
            ...createYadioApiDep(),
            selfPayDefaultRelays: cliEnv.PAYKY_SELF_PAY_RELAYS,
            nostrRelayClient: createNostrRelayClient(),
            lockManager: createInProcessLockManager(),
            onError: (error: unknown) => {
              appConsole.error("Background job failed.", error)
            },
          })(async (run) => {
            await run.ok(registerCliDevice(deviceId))
            const backgroundJobsDisposable = await run.ok(
              runBackgroundJobs(nativeBackgroundJobs)
            )
            run.deps.console.log("Background jobs are running.")
            return ok(backgroundJobsDisposable)
          })
        })
    )

    program.addCommand(backgroundJobsCommand)
    return ok(undefined)
  }
