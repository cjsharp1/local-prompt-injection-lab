/**
 * outbox.ts — the simulated outbox: where "sent" email goes instead of the world.
 *
 * send_email writes here, and so does the app when it delivers the
 * assistant's reply to the customer. Nothing in this file — or anywhere in
 * the lab — opens a network connection. The outbox is an in-memory list
 * per run, returned in every tool result's `_meta["lab/outbox"]`, so the
 * app, the UI and the scorer all read the same record of what would have
 * been sent, and to whom.
 *
 * It is the tool server's only state. That is deliberate: the record of
 * what was sent belongs with the thing that "sent" it, not with the caller
 * that asked — the same reason a real mail server, not the app, is the
 * authority on what left the building.
 *
 * Runs are kept by id. Only the most recent runs are kept (a long arena
 * would otherwise grow this forever); a run's record is needed only while
 * the run is being scored.
 */

import type { OutboxEntry } from "../shared/shop.js";

/** How many runs' outboxes to keep in memory. */
const KEEP_RUNS = 200;

/** The id used for calls that arrive with no session (MCP Inspector, say). */
export const NO_SESSION_RUN = "no-session";

const boxes = new Map<string, OutboxEntry[]>();

/** Adds a message to a run's outbox and returns it with its id and time. */
export function addToOutbox(runId: string, entry: Omit<OutboxEntry, "messageId" | "at">): OutboxEntry {
  let box = boxes.get(runId);
  if (!box) {
    box = [];
    boxes.set(runId, box);
    // Maps iterate in insertion order, so the first key is the oldest run.
    if (boxes.size > KEEP_RUNS) {
      const oldest = boxes.keys().next().value;
      if (oldest !== undefined) boxes.delete(oldest);
    }
  }
  const full: OutboxEntry = {
    ...entry,
    messageId: `M-${String(box.length + 1).padStart(4, "0")}`,
    at: new Date().toISOString(),
  };
  box.push(full);
  return full;
}

/** Everything in a run's outbox so far, oldest first. */
export function outboxFor(runId: string): OutboxEntry[] {
  return [...(boxes.get(runId) ?? [])];
}
