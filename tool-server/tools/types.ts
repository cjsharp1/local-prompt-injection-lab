/**
 * types.ts — what a tool is, and what it is allowed to touch.
 *
 * Every tool in definitions/ is a `ToolDefinition`. This file defines that
 * shape and nothing else, and it imports nothing from this project except
 * types from shared/ — it is the bottom of the dependency graph on
 * purpose:
 *
 *   types.ts  ←  definitions/*.ts  ←  registry.ts  ←  mcp-server.ts
 *
 * That order is a rule, not tidiness. Put the interface in the registry
 * instead, and each definition imports the registry while the registry
 * imports each definition: a cycle. It works with one tool and throws
 * "Cannot access '…' before initialization" with two, depending on which
 * file Node happens to load first.
 *
 * ---------------------------------------------------------------------------
 * What a tool can reach
 * ---------------------------------------------------------------------------
 *
 * A tool's `run` receives its validated arguments and a `ToolContext`, and
 * nothing else:
 *
 *   db           runs a SELECT with bound parameters against a database
 *                opened read-only — no handle, no file system, no network
 *   session      the run's LabSession, read from the request's `_meta` —
 *                which ticket is open, the canaries, the attack overlays
 *   customer     the open ticket's customer, looked up by the tool server
 *                itself from the session's ticket id. NEVER taken from a
 *                model-written argument; that is the whole point
 *   enforce      whether the permission layer (layer 5) is on
 *   overlays     applies the run's attack overlays to text, and records
 *                which ones landed so the UI can highlight them
 *   fill         puts the run's canary values into their placeholders
 *   outbox       the run's simulated outbox (send_email only)
 *
 * Permission checks do not live in tools. They are in permissions.ts and
 * run BEFORE a tool is called, so no tool can forget one. The one
 * exception is search_help_articles, which withholds internal articles
 * from its results rather than refusing the whole call — a filter, not a
 * refusal — and so needs to know whether `enforce` is on.
 *
 * ---------------------------------------------------------------------------
 * What a tool returns
 * ---------------------------------------------------------------------------
 *
 *   data   the structured result, for the UI and the scorer
 *   text   what the MODEL reads
 *
 * Unlike a tool built to save context, the text here carries the
 * untrusted content VERBATIM: the ticket body, the attachment, the
 * delivery note, the community answers. That content is the attack
 * surface the lab exists to show. Summarizing it would be a defense in
 * itself — an unlabelled one — so it is not done. Each free-text field is
 * capped in length, and the cap is stated in the text.
 */

import type { z } from "zod";
import type { LabSession, OutboxEntry } from "../../shared/shop.js";

/** A value that can be bound to a placeholder. */
export type SqlValue = string | number | null;

/** Values for `:name` placeholders, keyed by name without the colon. */
export type NamedParams = Record<string, SqlValue>;

/**
 * Parameters for one statement: positional values for `?` placeholders,
 * or a single object for `:name` placeholders.
 *
 * Use named parameters whenever a value appears more than once. SQLite's
 * numbered `?1` does NOT work positionally in node:sqlite — it counts
 * `?1` as a named parameter, so values passed in order find no slot and
 * the call fails with "column index out of range".
 */
export type SqlParams = SqlValue[] | [NamedParams];

/**
 * Runs read-only SQL on a tool's behalf, and records each query.
 * Implemented in db.ts; declared here so tools depend on the interface.
 */
export interface QueryRunner {
  all<Row>(sql: string, ...params: SqlParams): Row[];
  get<Row>(sql: string, ...params: SqlParams): Row | undefined;
}

/** The open ticket's customer, as the tool server itself looked them up. */
export interface SessionCustomer {
  id: string;
  name: string;
  email: string;
}

/** Applies overlays to one piece of text and records which ones landed. */
export interface OverlayApplier {
  /** The overlays of one kind that match, for a tool to apply as it sees fit. */
  matching<K extends LabSession["overlays"][number]["kind"]>(
    kind: K,
    predicate?: (overlay: Extract<LabSession["overlays"][number], { kind: K }>) => boolean,
  ): Array<Extract<LabSession["overlays"][number], { kind: K }>>;
  /** Marks an overlay as applied: it reached this result. */
  applied(id: string): void;
}

export interface ToolContext {
  db: QueryRunner;
  session: LabSession | null;
  customer: SessionCustomer | null;
  enforce: boolean;
  overlays: OverlayApplier;
  fill(text: string): string;
  outbox: {
    add(entry: Omit<OutboxEntry, "messageId" | "at">): OutboxEntry;
  };
}

/** What a successful tool run produces. */
export interface ToolOutput<TData> {
  data: TData;
  text: string;
}

/**
 * A failure the MODEL should read and act on.
 *
 * "No order TA-99999. Order ids look like TA-20417." is information, not
 * a crash. Throwing one of these becomes an MCP result with
 * `isError: true` and this message as its text. Anything else that throws
 * is a real bug and is reported as one. Matched by class, never by text.
 */
export class ToolError extends Error {
  override name = "ToolError";
}

/** One tool, as the tool server registers it. */
export interface ToolDefinition<TInput, TData> {
  /** What a client calls it by: lowercase with underscores. */
  name: string;

  /** A short human name, e.g. "Look up order". */
  title: string;

  /**
   * Written for the MODEL, and part of the fixed setup every arena run
   * shares: changing a description changes the experiment. Says what the
   * tool is for and what it is not for.
   */
  description: string;

  /** The arguments. The SDK validates every call against it before `run`. */
  inputSchema: z.ZodType<TInput>;

  /** The structured result's shape, checked by the SDK on every success. */
  outputSchema: z.ZodType<TData>;

  /**
   * True for tools that need a human's confirmation when the permission
   * layer is on (get_internal_notes). The confirmation round trip is run
   * by mcp-server.ts, before `run` is reached.
   */
  needsConfirmation?: boolean;

  /** Does the work. Throws `ToolError` for anything the model can fix. */
  run(input: TInput, ctx: ToolContext): ToolOutput<TData>;
}

/** The registry's view of a tool: input and output types erased. */
export type AnyTool = ToolDefinition<never, unknown>;

/** Checks a tool against its own types, then widens it for the registry. */
export function defineTool<TInput, TData>(tool: ToolDefinition<TInput, TData>): AnyTool {
  return tool as unknown as AnyTool;
}

