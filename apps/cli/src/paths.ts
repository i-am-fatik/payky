import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const repositoryRoot = fileURLToPath(
  new URL("../../..", import.meta.url)
)

export const resolveSqlitePath = (
  value: string | undefined,
  cwd: string,
  defaultFilename = "payky.db"
): string =>
  value === undefined
    ? resolve(repositoryRoot, ".data", defaultFilename)
    : resolve(cwd, value)
