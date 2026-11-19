/**
 * pipeline.ts — the turn drawn as stages, so you can see where an attack was stopped.
 *
 * Five columns, left to right, in the order a turn passes through them:
 *
 *   Input    the attack text arriving, spotlighting's fences, the
 *            classifier's verdicts, the quarantined reader's facts
 *   Model    every request to the model and its response, the hardened
 *            prompt, reasoning when it is on
 *   Tools    every tool call and result, the output filter's checks, the
 *            tool server's permission verdicts
 *   Output   the structured reply, the output filter on it, delivery
 *   Scoring  the outcome, once the run is scored
 *
 * Built from the same log rows the activity log shows — each row carries
 * its level, and a defence's row carries its stage — so the two views
 * cannot disagree. Each card shows what the stage received or decided,
 * and clicking one scrolls the log to its row, with the full detail.
 *
 * When a defence blocks the run, its card is marked as the end of the
 * line, and the columns after it are greyed: those stages were never
 * reached.
 */

import { byId, el } from "./dom.js";
import { onRow } from "./log.js";
import type { LogEvent, RunRecord } from "./types.js";

type Column = "input" | "model" | "tools" | "output" | "scoring";
const COLUMNS: Array<[Column, string]> = [["input", "Input"], ["model", "Model"], ["tools", "Tools"], ["output", "Output"], ["scoring", "Scoring"]];

/** Which column a log row belongs in. */
function columnFor(e: LogEvent): Column | undefined {
  if (e.level === "defense") {
    if (e.stage === "input") return "input";
    if (e.stage === "model") return "model";
    if (e.stage === "tool") return "tools";
    return "output";
  }
  if (e.actor === "attacker") return "input";
  if (e.level === "model") return "model";
  if (e.level === "tool" && e.label.startsWith("app loaded ticket")) return "input";
  if (e.level === "tool") return /delivered the reply|holding message/.test(e.label) ? "output" : "tools";
  if (e.level === "info" && e.label.startsWith("Structured reply")) return "output";
  if (e.level === "warn" && e.label.startsWith("Run stopped")) return "output";
  if (e.level === "error") return "output";
  return undefined;
}

function column(c: Column): HTMLElement {
  return byId(`stage-${c}`);
}

/** Empties the view for a new run. */
export function resetPipeline(): void {
  byId("pipeline").replaceChildren(...COLUMNS.map(([id, title]) =>
    el("div", { class: "stage", attrs: { id: `stage-col-${id}` } }, [
      el("div", { class: "stage-title", text: title }),
      el("div", { class: "stage-cards", attrs: { id: `stage-${id}` } }),
    ])));
}

/** Adds a card for every log row that belongs to a stage. */
export function initPipeline(): void {
  resetPipeline();
  onRow((event, row) => {
    const c = columnFor(event);
    if (!c) return;
    const blocked = /blocked|FLAGGED|withheld|declined|refused/i.test(event.label) && event.level === "defense";
    const card = el("button", {
      class: `stage-card level-card-${event.level}${blocked ? " card-blocked" : ""}${event.actor === "attacker" ? " card-attacker" : ""}`,
      attrs: { type: "button" },
      text: `${event.iteration !== undefined ? `#${event.iteration} ` : ""}${event.label}`,
    });
    card.addEventListener("click", () => {
      row.scrollIntoView({ block: "center" });
      row.classList.add("flash");
      setTimeout(() => row.classList.remove("flash"), 1200);
    });
    column(c).append(card);
  });
}

/** Shows the scored outcome, and greys the stages a block kept the run from reaching. */
export function showOutcome(record: RunRecord): void {
  const o = record.outcome;
  const text = o.kind === "blocked" || o.kind === "falsely-blocked" ? `${o.kind} by ${o.layer} at the ${o.stage} stage` : o.kind;
  column("scoring").append(el("div", { class: `stage-card outcome-card outcome-${o.kind}`, text }));

  if ((o.kind === "blocked" && !o.attempted) || o.kind === "falsely-blocked" || record.loopOutcome === "stopped") {
    const stopStage = o.kind === "blocked" || o.kind === "falsely-blocked" ? o.stage : "input";
    const order: Column[] = ["input", "model", "tools", "output"];
    const map: Record<string, Column> = { input: "input", model: "model", tool: "tools", output: "output" };
    const from = order.indexOf(map[stopStage] ?? "input");
    for (const c of order.slice(from + 1)) {
      if (column(c).children.length === 0) byId(`stage-col-${c}`).classList.add("not-reached");
    }
  }
}
