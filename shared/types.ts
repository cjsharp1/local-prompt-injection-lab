/**
 * types.ts — the shapes that travel between the lab's server and the browser.
 *
 * This file is the contract for the whole app. The server builds these
 * objects, sends them as JSON over Server-Sent Events, and the browser
 * parses them back out. Nothing here has any behaviour: it is types only,
 * and it compiles to nothing at all. Both halves import it, so they cannot
 * quietly disagree about what crosses the connection.
 *
 * DRAFT until the UI lands (build step 12): the log row, the defence
 * vocabulary, the pipeline stages and the stream events are here; the
 * pipeline-view event and the run outcome are added by the steps that
 * produce them. The assistant's structured reply lives in shared/shop.ts,
 * beside the shop it talks about.
 *
 * ---------------------------------------------------------------------------
 * The promise this file serves
 * ---------------------------------------------------------------------------
 *
 * The lab's rule is that if something happens and the UI does not show
 * it, that is a bug. Most of what happens — a model request, a tool call,
 * a defence inspecting an attack — reaches the browser as a LogEvent, so
 * the log row has to be able to say all of it: what kind of thing
 * happened, which way it travelled, whose decision it was, which defence
 * layer acted, at which stage of the pipeline, and why.
 */

import type { RunRecord } from "./arena.js";

// ---------------------------------------------------------------------------
// The defences' vocabulary
// ---------------------------------------------------------------------------

/**
 * Where in one turn a defence acts. A turn passes through these in order:
 *
 *   input   untrusted text arriving — the ticket, an attachment, a tool
 *           result — before the model sees it
 *   model   what the model is told: the system prompt
 *   tool    a tool call the model asked for, before (and, for the
 *           permission layer, inside) the tool server
 *   output  the structured reply, before it is delivered to the customer
 */
export type Stage = "input" | "model" | "tool" | "output";

/**
 * How much a defence can be relied on — said on every badge, so no layer
 * is mistaken for a guarantee.
 *
 *   soft    asks the model to behave; holds only as long as it does
 *   medium  enforced by code or by a second model, but matches only what
 *           it was written (or able) to recognise, so it can be bypassed
 *   hard    holds whatever the model decides, within a stated scope:
 *           a permission in the tool server, or a model that never sees
 *           the attacker's text
 */
export type Strength = "soft" | "medium" | "hard";

/** The six layers, by id. One file each in server/defenses/. */
export type DefenseId =
  | "hardened-prompt"
  | "spotlighting"
  | "classifier"
  | "output-filter"
  | "tool-permissions"
  | "privilege-separation";

/**
 * Which layers are on for a turn. Every layer defaults to OFF: the lab
 * starts from the undefended app, and the reader adds defences one at a
 * time to watch what each one stops — and what it costs.
 */
export type DefenseSettings = Record<DefenseId, boolean>;

// ---------------------------------------------------------------------------
// Log events
// ---------------------------------------------------------------------------

/**
 * What kind of thing a log row describes — about WHAT happened, not
 * severity in the usual logging sense.
 *
 *   info     the app did something on its own: a turn starting, the
 *            ticket loading, the tool server connecting
 *   model    a request to the local model, or its response (with tokens
 *            per second and prompt tokens against the context window)
 *   tool     an MCP tool being called, and its result
 *   data     a SQL query the tool server ran, as reported in the result
 *   defense  a defence layer inspected something and decided: pass,
 *            transform or block. Logged even when it passes — "the
 *            classifier looked and saw nothing" is information
 *   warn     nothing failed, but you should know: a tool call written as
 *            text, the context window nearly full
 *   error    something failed. Never counted as an attack succeeding or
 *            failing, and always shown prominently
 *
 * `defense` is its own level, not a kind of `warn`, because a defence
 * acting is the event a reader is watching for. Folded into `warn`, it
 * would sit among context-window notices and be easy to miss.
 */
export type LogLevel = "info" | "model" | "tool" | "data" | "defense" | "warn" | "error";

/**
 * Which way a logged event travelled, if it travelled at all.
 *
 *   out   this app → the model. A request.
 *   in    the model → this app. A response.
 *   call  this app → a tool. A call into the tool server.
 *   back  a tool → this app. Its result.
 *   none  neither; an internal note — including every defence decision
 *         made in this process
 *
 * The test: did data cross a boundary AT THE MOMENT this row was logged?
 */
export type LogDirection = "out" | "in" | "call" | "back" | "none";

/**
 * Whose decision a row records.
 *
 *   user      the person using the lab: running an attack, toggling a
 *             layer, answering a confirmation dialog
 *   app       this server's own code, including the defence layers
 *   model     the local model, via something in its response
 *   tool      a tool in the tool server — including the permission layer,
 *             which lives there
 *   attacker  the payload itself: rows that show where attack text landed
 */
export type LogActor = "user" | "app" | "model" | "tool" | "attacker";

/** One line in the activity log. */
export interface LogEvent {
  /** Which kind of event this is. Decides the colour of the tag word. */
  level: LogLevel;

  /** Which way it travelled. Absent means "none". Tints the row. */
  direction?: LogDirection;

  /** Whose decision it was. */
  actor?: LogActor;

  /** Which model request in the turn this row belongs to, for grouping. */
  iteration?: number;

  /** For `defense` rows: which layer acted. */
  layer?: DefenseId;

  /** For `defense` rows, and any row tied to one: the pipeline stage. */
  stage?: Stage;

  /** Why this happened, as a fragment that completes "because…". */
  because?: string;

  /** A short, human-readable summary: the whole of what the row shows by default. */
  label: string;

  /**
   * The full data behind the event: a request body, a tool result, a
   * defence's verdict. Rendered collapsed. `unknown`, not `any`, so the
   * rendering code has to handle it defensively — it is often attacker
   * text, and it is always rendered with textContent.
   */
  detail?: unknown;

  /** Milliseconds since the epoch. */
  at: number;
}

// ---------------------------------------------------------------------------
// Stream events: everything one run sends to whoever is watching
// ---------------------------------------------------------------------------

/**
 * What the pipeline emits while a run happens. The UI receives these over
 * Server-Sent Events; the terminal scripts print them; the arena counts
 * them. The pipeline never knows which — it is handed an `emit` function.
 *
 *   log         one activity-log row (most of what happens)
 *   reasoning   the model's reasoning for one request, when Show reasoning is on
 *   tool_start  a tool call is about to be sent
 *   tool_end    its result came back
 *   confirm     the tool server asks a person to confirm (layer 5): the
 *               browser shows a dialog and answers through /api/confirm
 *   done        the run finished; the summary for the workspace
 *   error       the run failed, with a message a person can read
 *   result      the scored record — the same shape the arena stores
 */
export type StreamEvent =
  | { type: "log"; event: LogEvent }
  | { type: "reasoning"; request: number; text: string; seconds: number }
  | { type: "tool_start"; id: string; name: string; args: Record<string, unknown>; iteration: number }
  | { type: "tool_end"; id: string; name: string; isError: boolean; elapsedMs: number }
  | { type: "done"; runId: string; requests: number; elapsedMs: number }
  | { type: "error"; message: string }
  | { type: "confirm"; id: string; message: string }
  | { type: "result"; record: RunRecord };
