import { type CreateSqliteDriver, createRun, Port } from "@evolu/common"
import {
  createBetterSqliteDriver,
  createRelay,
  createRelayDeps,
} from "@evolu/nodejs"

import { MasterKey } from "../modules/shared/key-derivation.ts"
import { createNodeEvolu } from "../runtime/node-evolu.ts"

type NodeEvolu = Awaited<ReturnType<typeof createNodeEvolu>>

export interface SyncedDevices extends AsyncDisposable {
  readonly addDevice: () => Promise<NodeEvolu["evolu"]>
}

export const createSyncedDevices = async (
  masterKey: MasterKey = MasterKey("00112233445566778899aabbccddeeff")
): Promise<SyncedDevices> => {
  await using disposer = new AsyncDisposableStack()
  const run = disposer.use(
    createRun({
      ...createRelayDeps(),
      createSqliteDriver: ((name) =>
        createBetterSqliteDriver(name, {
          mode: "memory",
        })) satisfies CreateSqliteDriver,
    })
  )
  const relay = disposer.use(
    await run.ok(
      createRelay({ port: Port.orThrow(0), isOwnerWithinQuota: () => true })
    )
  )
  const devices = new AsyncDisposableStack()
  disposer.use(devices)
  const disposables = disposer.move()

  return {
    addDevice: async () =>
      devices.use(
        await createNodeEvolu("memory", {
          masterKey,
          transports: [
            { type: "WebSocket", url: `ws://localhost:${relay.port}` },
          ],
        })
      ).evolu,
    [Symbol.asyncDispose]: () => disposables.disposeAsync(),
  }
}
