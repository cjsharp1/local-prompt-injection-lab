/**
 * logger.ts — builds activity-log rows and hands them to whoever is listening.
 *
 * Every component that does something worth seeing — the tool loop, the
 * MCP client, every defence layer — reports it through a `Logger`. The
 * logger stamps each row with the time and the current iteration and
 * passes it to a SINK: a function that decides where rows go.
 *
 * That indirection is what lets the same agent loop run in three places:
 *
 *   the web app    the sink writes each row to the browser as an SSE event
 *   attack.ts      the sink prints each row to the terminal
 *   arena.ts       the sink collects rows into the run record
 *
 * The pipeline never knows which. It takes a Logger, never an HTTP
 * response, so it can be debugged from the terminal before any UI exists.
 *
 * Defence layers log through `defense()`, which requires the layer and
 * the stage: a row that says "something blocked this" without saying
 * which layer, at which point in the turn, would break the lab's promise
 * that every decision is visible and attributable.
 *
 * The row shape — level, direction, actor, because, label, detail — is
 * defined in shared/types.ts, where the browser reads it too. See that
 * file for what each level means and how to choose a direction.
 */

import type { DefenseId, LogActor, LogDirection, LogEvent, LogLevel, Stage } from "../shared/types.js";

/** Where log rows go. */
export type LogSink = (event: LogEvent) => void;

/** The optional parts of a row. */
export interface LogExtras {
  direction?: LogDirection;
  actor?: LogActor;
  because?: string;
  stage?: Stage;
}

export class Logger {
  /**
   * The model request this row belongs to, set by the loop as it goes.
   * Undefined outside a turn (e.g. while connecting to the data server).
   */
  iteration: number | undefined;

  constructor(private readonly sink: LogSink) {}

  private emit(level: LogLevel, label: string, detail: unknown, extras: LogExtras & { layer?: DefenseId }): void {
    this.sink({
      level,
      label,
      at: Date.now(),
      ...(detail !== undefined ? { detail } : {}),
      ...(this.iteration !== undefined ? { iteration: this.iteration } : {}),
      ...extras,
    });
  }

  /** The app did something on its own. */
  info(label: string, detail?: unknown, extras: LogExtras = {}): void {
    this.emit("info", label, detail, { actor: "app", ...extras });
  }

  /** A request to, or response from, the local model. */
  model(label: string, detail?: unknown, extras: LogExtras = {}): void {
    this.emit("model", label, detail, extras);
  }

  /** An MCP tool call or its result. */
  tool(label: string, detail?: unknown, extras: LogExtras = {}): void {
    this.emit("tool", label, detail, extras);
  }

  /** SQL the tool server reports it ran. */
  data(label: string, detail?: unknown, extras: LogExtras = {}): void {
    this.emit("data", label, detail, { actor: "tool", ...extras });
  }

  /**
   * A defence layer inspected something and decided — pass, transform or
   * block. Logged every time, including "pass": "the classifier looked and
   * found nothing" is information. Layer and stage are required.
   */
  defense(layer: DefenseId, stage: Stage, label: string, detail?: unknown, extras: Omit<LogExtras, "stage"> = {}): void {
    this.emit("defense", label, detail, { actor: "app", ...extras, stage, layer });
  }

  /** Nothing failed, but you should know: a tool call written as text, a nearly full context window. */
  warn(label: string, detail?: unknown, extras: LogExtras = {}): void {
    this.emit("warn", label, detail, { actor: "app", ...extras });
  }

  /** Something failed. */
  error(label: string, detail?: unknown, extras: LogExtras = {}): void {
    this.emit("error", label, detail, { actor: "app", ...extras });
  }
}

/** Shortens text for a label, with an ellipsis when it was cut. */
export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
