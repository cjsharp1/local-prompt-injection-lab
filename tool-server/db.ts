/**
 * db.ts — opens the shop database read-only, and records every query.
 *
 * This is the only file in the tool server that touches SQLite. Tools
 * never see the database handle; they get a `QueryRunner` (defined in
 * tools/types.ts) that can do two things — run a parameterised SELECT and
 * return rows — and that writes down what it ran.
 *
 * ---------------------------------------------------------------------------
 * Read-only is enforced by how the file is opened
 * ---------------------------------------------------------------------------
 *
 * `new DatabaseSync(path, { readOnly: true })` opens the file in SQLite's
 * read-only mode. Any INSERT, UPDATE, DELETE or DDL then fails inside
 * SQLite itself with "attempt to write a readonly database" — whatever
 * code issued it. That is a stronger guarantee than "no tool happens to
 * contain a write": it would still hold if someone added a careless tool
 * tomorrow.
 *
 * Combined with the other two rules — tools only ever bind parameters
 * into fixed SQL, and there is no tool that accepts SQL — the model can
 * neither change the shop nor run a query nobody wrote. (The one thing a
 * tool can "write" is the simulated outbox, which lives in memory in
 * outbox.ts, never in this database.)
 *
 * ---------------------------------------------------------------------------
 * Every query reports itself
 * ---------------------------------------------------------------------------
 *
 * `createRecorder()` returns a runner plus the list of queries it ran:
 * statement, parameters, row count, milliseconds. The MCP layer attaches
 * that list to the tool result's `_meta`, and the app shows each entry as
 * a `data` row in the activity log — so a learner can see the SQL behind
 * every answer, not just the answer.
 *
 * ---------------------------------------------------------------------------
 * Two traps
 * ---------------------------------------------------------------------------
 *
 * The path is resolved from THIS FILE, not from the current directory.
 * The app spawns the tool server as a child process, and a cwd-relative
 * path breaks as soon as something launches it from another folder. From
 * tool-server/db.ts or dist/tool-server/db.js, `../data/shop.db` lands on
 * the right file either way (scripts/copy-data.ts puts a copy in
 * dist/data for the built version).
 *
 * node:sqlite is still marked experimental in Node 24, so importing it
 * prints an ExperimentalWarning. That goes to STDERR, which matters here:
 * over stdio, stdout is the MCP protocol stream and must carry nothing
 * else. A warning on stderr is harmless; the same text on stdout would
 * corrupt the connection.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { QueryReport } from "../shared/shop.js";
import type { NamedParams, QueryRunner, SqlParams } from "./tools/types.js";

/** Where the database lives, relative to this file. */
export const DB_PATH = fileURLToPath(new URL("../data/shop.db", import.meta.url));

/**
 * The database is missing — almost always a fresh clone that has not run
 * the seed yet. A class of its own so entry points can catch it and print
 * the fix, rather than a raw SQLite "unable to open database file".
 */
export class DatabaseMissingError extends Error {
  override name = "DatabaseMissingError";
  constructor() {
    super(`No database at ${DB_PATH}. Run:  npm run seed`);
  }
}

/** The one connection, opened on first use and kept for the process. */
let connection: DatabaseSync | undefined;

/**
 * Opens the database read-only, once.
 *
 * One connection for the whole process is fine — and simpler than one per
 * request — because nothing writes: there is no transaction to isolate
 * and no lock to contend for. `DatabaseSync` is synchronous, so two tool
 * calls cannot interleave on it either.
 */
export function openDatabase(): DatabaseSync {
  if (connection) return connection;

  // Checked first because SQLite's own error for a missing file in
  // read-only mode ("unable to open database file") does not say what to
  // do about it.
  if (!existsSync(DB_PATH)) throw new DatabaseMissingError();

  connection = new DatabaseSync(DB_PATH, { readOnly: true });
  return connection;
}

/** A runner for one tool call, and the queries it ran. */
export interface Recorder {
  runner: QueryRunner;
  queries: QueryReport[];
}

/**
 * Creates a fresh recorder for one tool call.
 *
 * Fresh per call so each result reports only its own queries. A shared
 * list would mix two calls' SQL together the moment two clients (the app
 * and MCP Inspector, say) used the server at once.
 */
export function createRecorder(): Recorder {
  const db = openDatabase();
  const queries: QueryReport[] = [];

  /** Runs one statement, timing it and writing it down. */
  function run<Row>(sql: string, params: SqlParams, mode: "all" | "get"): Row[] {
    const started = performance.now();
    const statement = db.prepare(sql);

    // One object means named parameters (`:customer`); anything else is a
    // list of positional values for `?`. node:sqlite takes the object as
    // its first argument and matches keys to names without the colon.
    const first = params[0];
    const named: NamedParams | undefined =
      params.length === 1 && typeof first === "object" && first !== null ? first : undefined;
    const positional = named ? [] : (params as Array<string | number | null>);

    const rows =
      mode === "all"
        ? (named ? statement.all(named) : statement.all(...positional))
        : [named ? statement.get(named) : statement.get(...positional)].filter((row) => row !== undefined);

    queries.push({
      // Collapsed to one line for the log: the source keeps its
      // indentation for readability, the log row does not need it.
      sql: sql.replace(/\s+/g, " ").trim(),
      params: named ?? positional,
      rows: rows.length,
      ms: Math.round((performance.now() - started) * 100) / 100,
    });

    // node:sqlite returns plain objects keyed by column name. The cast is
    // the one place a row's shape is asserted rather than checked: each
    // tool's SELECT names its columns, and the tool's output schema is
    // validated by the SDK before anything leaves the server.
    return rows as Row[];
  }

  return {
    queries,
    runner: {
      all: <Row>(sql: string, ...params: SqlParams) => run<Row>(sql, params, "all"),
      get: <Row>(sql: string, ...params: SqlParams) => run<Row>(sql, params, "get")[0],
    },
  };
}
