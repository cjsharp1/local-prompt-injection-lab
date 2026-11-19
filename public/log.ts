/**
 * log.ts — the activity log: one row per event, in order, nothing hidden.
 *
 * Each row is label-first and readable without clicking: a level tag, a
 * direction arrow, the label, and for a defence's decision a chip naming
 * the layer and the pipeline stage. The full detail — a request body, a
 * tool result, a classifier's verdict, a reasoning trace — is one click
 * away in a collapsed tree (json-tree.ts).
 *
 * Two dimensions, kept apart on purpose (shared/types.ts):
 *
 *   level      what KIND of event: colours the tag word. `defense` has
 *              its own colour, because a defence acting is what a reader
 *              is watching for
 *   direction  which way data moved: draws the arrow and tints the row
 *
 * Rows whose actor is the ATTACKER — "attack text landed in the lookup
 * result" — get their own marker, so the moment a payload arrives is easy
 * to find.
 *
 * Every label and detail renders with textContent. They include attack
 * payloads, model output and tool results; here they are text, whatever
 * they say.
 */

import { buildJsonTree } from "./json-tree.js";
import { byId, clock, el } from "./dom.js";
import type { LogEvent } from "./types.js";

/** The arrow drawn for each direction. */
const ARROW: Record<string, string> = { out: "→", in: "←", call: "⇢", back: "⇠", none: "·" };

const DIRECTION_TITLE: Record<string, string> = {
  out: "app → model (a request)",
  in: "model → app (a response)",
  call: "app → tool server (a tool call)",
  back: "tool server → app (a result)",
  none: "nothing crossed a boundary",
};

/** Called with each row as it is added — the pipeline view listens here. */
type RowListener = (event: LogEvent, row: HTMLElement) => void;
const listeners: RowListener[] = [];
export function onRow(listener: RowListener): void {
  listeners.push(listener);
}

function list(): HTMLElement {
  return byId("log-rows");
}

function atBottom(): boolean {
  const scroller = byId("log-scroll");
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
}

/** A divider before each run's rows. */
export function logDivider(text: string): void {
  const follow = atBottom();
  list().append(el("li", { class: "log-divider" }, [el("span", { text })]));
  if (follow) byId("log-scroll").scrollTop = byId("log-scroll").scrollHeight;
}

/** Appends one event as a row, and tells the listeners. */
export function appendLog(event: LogEvent): HTMLElement {
  const follow = atBottom();
  const direction = event.direction ?? "none";

  const head = el("div", { class: "log-head" }, [
    el("span", { class: `log-level level-${event.level}`, text: event.level }),
    el("span", { class: "log-arrow", text: ARROW[direction] ?? "·", title: DIRECTION_TITLE[direction] ?? "" }),
    el("span", { class: "log-label", text: event.label }),
    event.layer ? el("span", { class: "log-chip", text: `${event.layer} · ${event.stage ?? ""}` }) : null,
    el("span", { class: "log-meta", text: `${event.iteration !== undefined ? `#${event.iteration} · ` : ""}${clock(event.at)}` }),
  ]);

  const parts: HTMLElement[] = [head];
  if (event.because) parts.push(el("div", { class: "log-because", text: `because ${event.because}` }));
  if (event.detail !== undefined) {
    // Built on first open: a model request with five tool schemas is a
    // large tree, and most rows are never expanded.
    const details = el("details", { class: "log-detail" }, [el("summary", { text: "detail" })]);
    details.addEventListener("toggle", () => {
      if (details.open && details.children.length === 1) details.append(buildJsonTree(event.detail));
    });
    parts.push(details);
  }

  const row = el("li", {
    class: `log-row dir-${direction} row-${event.level}${event.actor === "attacker" ? " row-attacker" : ""}`,
    attrs: event.actor ? { "data-actor": event.actor } : {},
  }, parts);
  list().append(row);
  if (follow) byId("log-scroll").scrollTop = byId("log-scroll").scrollHeight;
  for (const listener of listeners) listener(event, row);
  return row;
}

/** Empties the panel. */
export function clearLog(): void {
  list().replaceChildren();
}
