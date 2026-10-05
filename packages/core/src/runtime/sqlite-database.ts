import type { SqliteQuery } from "@evolu/common"
import BetterSQLite from "better-sqlite3"

type SqliteParameters = SqliteQuery["parameters"]

export interface SqliteStatement {
  readonly reader: boolean
  readonly all: (parameters: SqliteParameters) => Array<unknown>
  readonly iterate: (parameters: SqliteParameters) => Iterable<unknown>
  readonly run: (parameters: SqliteParameters) => { readonly changes: number }
}

interface SqliteDatabase {
  readonly prepare: (sql: string) => SqliteStatement
  readonly serialize: () => Uint8Array
  readonly close: () => void
}

export type OpenSqliteDatabase = (filename: string) => SqliteDatabase

const openBetterSqliteDatabase: OpenSqliteDatabase = (filename) =>
  new BetterSQLite(filename)

interface BunSqliteStatement {
  readonly columnNames: ReadonlyArray<string>
  readonly all: (...parameters: SqliteParameters) => Array<unknown>
  readonly iterate: (...parameters: SqliteParameters) => Iterable<unknown>
  readonly run: (...parameters: SqliteParameters) => {
    readonly changes: number
  }
}

interface BunSqliteModule {
  readonly Database: new (
    filename: string
  ) => Omit<SqliteDatabase, "prepare"> & {
    readonly prepare: (sql: string) => BunSqliteStatement
  }
}

const bunSqliteModule = "bun:sqlite"

const loadBunSqliteDatabase = async (): Promise<OpenSqliteDatabase> => {
  const { Database } = (await import(
    /* @vite-ignore */ bunSqliteModule
  )) as BunSqliteModule

  return (filename) => {
    const db = new Database(filename)

    return {
      prepare: (sql) => {
        const statement = db.prepare(sql)
        return {
          reader: statement.columnNames.length > 0,
          all: (parameters) => statement.all(...parameters),
          iterate: (parameters) => statement.iterate(...parameters),
          run: (parameters) => statement.run(...parameters),
        }
      },
      serialize: () => db.serialize(),
      close: () => {
        db.close()
      },
    }
  }
}

export const loadOpenSqliteDatabase = async (): Promise<OpenSqliteDatabase> =>
  process.versions.bun === undefined
    ? openBetterSqliteDatabase
    : loadBunSqliteDatabase()
