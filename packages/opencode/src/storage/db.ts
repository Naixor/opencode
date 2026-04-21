import { Database as BunDatabase } from "bun:sqlite"
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { type SQLiteTransaction } from "drizzle-orm/sqlite-core"
export * from "drizzle-orm"
import { Context } from "../util/context"
import { lazy } from "../util/lazy"
import { Global } from "../global"
import { Log } from "../util/log"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod"
import path from "path"
import { readFileSync, readdirSync, existsSync } from "fs"
import * as schema from "./schema"

declare const OPENCODE_MIGRATIONS: { sql: string; timestamp: number }[] | undefined

export const NotFoundError = NamedError.create(
  "NotFoundError",
  z.object({
    message: z.string(),
  }),
)

const log = Log.create({ service: "db" })

export namespace Database {
  export const Path = path.join(Global.Path.data, "lark-opencode.db")
  type Schema = typeof schema
  export type Transaction = SQLiteTransaction<"sync", void, Schema>

  type Client = SQLiteBunDatabase<Schema>

  type Journal = { sql: string; timestamp: number }[]
  type Add = {
    timestamp: number
    table: string
    column: string
    sql: string
  }
  type Report = {
    add: Add[]
    journal: number[]
  }

  const state = {
    sqlite: undefined as BunDatabase | undefined,
  }

  function time(tag: string) {
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(tag)
    if (!match) return 0
    return Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
    )
  }

  function migrations(dir: string): Journal {
    const dirs = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)

    const sql = dirs
      .map((name) => {
        const file = path.join(dir, name, "migration.sql")
        if (!existsSync(file)) return
        return {
          sql: readFileSync(file, "utf-8"),
          timestamp: time(name),
        }
      })
      .filter(Boolean) as Journal

    return sql.sort((a, b) => a.timestamp - b.timestamp)
  }

  function statements(sql: string) {
    return sql
      .split("--> statement-breakpoint")
      .map((item) => item.trim())
      .filter(Boolean)
  }

  function adds(entry: Journal[number]) {
    return statements(entry.sql)
      .map((sql) => {
        const match = /^ALTER TABLE\s+[`"']?([^`"'\s]+)[`"']?\s+ADD(?:\s+COLUMN)?\s+[`"']?([^`"'\s]+)[`"']?/i.exec(sql)
        if (!match) return
        return {
          timestamp: entry.timestamp,
          table: match[1],
          column: match[2],
          sql,
        }
      })
      .filter(Boolean) as Add[]
  }

  function table(sqlite: BunDatabase, name: string) {
    return !!sqlite.query("select 1 from sqlite_master where type = 'table' and name = ? limit 1").get(name)
  }

  function column(sqlite: BunDatabase, name: string, col: string) {
    if (!table(sqlite, name)) return false
    return sqlite
      .query(`pragma table_info('${name.replaceAll("'", "''")}')`)
      .all()
      .some((row) => typeof row === "object" && row !== null && "name" in row && row.name === col)
  }

  function journal(sqlite: BunDatabase, timestamp: number) {
    if (!table(sqlite, "__drizzle_migrations")) return false
    return !!sqlite.query("select 1 from __drizzle_migrations where created_at = ? limit 1").get(timestamp)
  }

  function boot(sqlite: BunDatabase) {
    sqlite.run("PRAGMA journal_mode = WAL")
    sqlite.run("PRAGMA synchronous = NORMAL")
    sqlite.run("PRAGMA busy_timeout = 5000")
    sqlite.run("PRAGMA cache_size = -64000")
    sqlite.run("PRAGMA foreign_keys = ON")
    sqlite.run("PRAGMA wal_checkpoint(PASSIVE)")
  }

  function fix(sqlite: BunDatabase, entries: Journal): Report {
    const result: Report = {
      add: [],
      journal: [],
    }

    if (!table(sqlite, "__drizzle_migrations")) return result

    entries
      .map((entry) => adds(entry))
      .filter((item) => item.length > 0)
      .filter((item) => !journal(sqlite, item[0].timestamp))
      .forEach((item) => {
        const done = item.filter((part) => column(sqlite, part.table, part.column))
        if (done.length === 0) return

        item
          .filter((part) => !column(sqlite, part.table, part.column))
          .forEach((part) => {
            log.warn("repairing migration column", {
              table: part.table,
              column: part.column,
              timestamp: part.timestamp,
            })
            sqlite.run(part.sql)
            result.add.push(part)
          })

        if (!item.every((part) => column(sqlite, part.table, part.column))) return

        log.warn("repairing migration journal", {
          timestamp: item[0].timestamp,
        })
        sqlite.query("insert into __drizzle_migrations (hash, created_at) values (?, ?)").run("", item[0].timestamp)
        result.journal.push(item[0].timestamp)
      })

    return result
  }

  function open() {
    const sqlite = new BunDatabase(Path, { create: true })
    boot(sqlite)
    return sqlite
  }

  function entries() {
    return typeof OPENCODE_MIGRATIONS !== "undefined"
      ? OPENCODE_MIGRATIONS
      : migrations(path.join(import.meta.dirname, "../../migration"))
  }

  export function repair() {
    const sqlite = open()
    try {
      const db = drizzle({ client: sqlite, schema })
      const list = entries()
      const result = fix(sqlite, list)
      if (list.length > 0) {
        log.info("applying migrations", {
          count: list.length,
          mode: typeof OPENCODE_MIGRATIONS !== "undefined" ? "bundled" : "dev",
        })
        migrate(db, list)
      }
      return result
    } finally {
      sqlite.close()
    }
  }

  export const Client = lazy(() => {
    log.info("opening database", { path: path.join(Global.Path.data, "lark-opencode.db") })

    const sqlite = open()
    state.sqlite = sqlite

    const db = drizzle({ client: sqlite, schema })

    // Apply schema migrations
    const list = entries()
    if (list.length > 0) {
      fix(sqlite, list)
      log.info("applying migrations", {
        count: list.length,
        mode: typeof OPENCODE_MIGRATIONS !== "undefined" ? "bundled" : "dev",
      })
      migrate(db, list)
    }

    return db
  })

  export function close() {
    const sqlite = state.sqlite
    if (!sqlite) return
    sqlite.close()
    state.sqlite = undefined
    Client.reset()
  }

  export type TxOrDb = Transaction | Client

  const ctx = Context.create<{
    tx: TxOrDb
    effects: (() => void | Promise<void>)[]
  }>("database")

  export function use<T>(callback: (trx: TxOrDb) => T): T {
    try {
      return callback(ctx.use().tx)
    } catch (err) {
      if (err instanceof Context.NotFound) {
        const effects: (() => void | Promise<void>)[] = []
        const result = ctx.provide({ effects, tx: Client() }, () => callback(Client()))
        for (const effect of effects) effect()
        return result
      }
      throw err
    }
  }

  export function effect(fn: () => any | Promise<any>) {
    try {
      ctx.use().effects.push(fn)
    } catch {
      fn()
    }
  }

  export function transaction<T>(callback: (tx: TxOrDb) => T): T {
    try {
      return callback(ctx.use().tx)
    } catch (err) {
      if (err instanceof Context.NotFound) {
        const effects: (() => void | Promise<void>)[] = []
        const result = Client().transaction((tx) => {
          return ctx.provide({ tx, effects }, () => callback(tx))
        })
        for (const effect of effects) effect()
        return result
      }
      throw err
    }
  }
}
