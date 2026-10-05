import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs"
import { dirname } from "node:path"
import { deriveAppOwner } from "@payky/core/evolu/client"
import {
  defaultEvoluTransportUrls,
  resolveTransportUrl,
} from "@payky/core/evolu/device-account"
import { mnemonicToMasterKey } from "@payky/core/modules/shared/key-derivation"
import {
  createNodeEvolu,
  type NodeEvoluAccount,
} from "@payky/core/runtime/node-evolu"
import { cliEnv } from "./cli-env.ts"
import { resolveSqlitePath } from "./paths.ts"

export const createCliEvolu = (
  filename: "memory" | string,
  account?: NodeEvoluAccount
) => {
  if (filename !== "memory") {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 })
    closeSync(openSync(filename, "a", 0o600))
    chmodSync(filename, 0o600)
  }
  return createNodeEvolu(filename, account)
}

export interface CliDatabasePathDep {
  readonly databasePath: string
}

export const createCliEvoluFromEnv = async () => {
  const mnemonic = cliEnv.PAYKY_RECOVERY_MNEMONIC
  if (mnemonic === undefined) {
    const databasePath = resolveSqlitePath(
      cliEnv.PAYKY_SQLITE_PATH,
      process.cwd()
    )
    const cliEvolu = await createCliEvolu(databasePath)
    return { ...cliEvolu, databasePath }
  }

  const masterKey = await mnemonicToMasterKey(mnemonic)
  const appOwnerId = deriveAppOwner(masterKey).id
  const databasePath = resolveSqlitePath(
    cliEnv.PAYKY_SQLITE_PATH,
    process.cwd(),
    `payky-${appOwnerId}.db`
  )

  const cliEvolu = await createCliEvolu(databasePath, {
    masterKey,
    transports: defaultEvoluTransportUrls.map((url) => ({
      type: "WebSocket",
      url: resolveTransportUrl(url, appOwnerId),
    })),
  })
  return { ...cliEvolu, databasePath }
}
