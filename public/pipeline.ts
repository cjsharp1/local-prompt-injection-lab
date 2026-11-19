/**
 * pipeline.ts — the turn drawn as a row of steps, so you can see where an attack was stopped.
 *
 * One compact card per step, left to right in the order the turn took
 * them, each tagged with its stage (Input, Model, Tool, Output, Score):
 *
 *   Ticket       the app loading the ticket, and any attack text it carries
 *   Request n    one request to the model AND its response, as one card:
 *                "Request 2 · tool loop" / "asked for lookup_order"
 *   lookup_order one tool call AND its result, as one card, with a badge
 *                when the tool server's permission check or the projection
 *                did something other than let it through
 *   Defense      only when a defense ACTS — flags, blocks, withholds,
 *                declines, refuses, filters, quarantines. A layer that
 *                checked and passed is in the activity log, not here.
 *   Reply        the structured reply, delivery or the holding message
 *   Outcome      the scored outcome, once the run is scored
 *
 * Why pairs: the activity log has a row for every half of every exchange,
 * which is right for a log and too much for an overview. An earlier
 * version drew one card per log row in five narrow columns; a short run
 * filled them with tall, wrapped fragments. Pairing halves and leaving out
 * passing checks keeps the picture to the few steps a person explains.
 *
 * Built from the same log rows the activity log shows, so the two views
 * cannot disagree. A card keeps its rows: hover it for their full text,
 * click it to jump to the first one in the log.
 */

import { byId, el } from "./dom.js";
import { onRow } from "./log.js";
import type { LogEvent, RunRecord } from "./types.js";

type Stage = "input" | "model" | "tool" | "output" | "score";
const STAGE_NAMES: Record<Stage, string> = { input: "Input", model: "Model", tool: "Tool", output: "Output", score: "Score" };

/** A card on the strip, and the log rows it stands for. */
interface Card {
  node: HTMLButtonElement;
  title: HTMLElement;
  sub: HTMLElement;
  badges: HTMLElement;
  rows: Array<{ event: LogEvent; row: HTMLElement }>;
}

/** The request card waiting for its response, and the tool card waiting for its result. */
let openRequest: Card | undefined;
let openTool: Card | undefined;
let jump: (row: HTMLElement) => void = () => {};

/**
 * Defense rows that record an action. Passing checks ("not flagged",
 * "nothing found", "allowed") are left to the log. Case matters for
 * FLAGGED: the classifier's pass row says "not flagged", and a
 * case-insensitive match once drew a card for every clean verdict.
 */
function acts(label: string): boolean {
  return /FLAGGED/.test(label) || /blocked|withheld|declined|refused|filtered|projected|quarantin/i.test(label);
}

function strip(): HTMLElement {
  return byId("pipeline");
}

function addRow(card: Card, event: LogEvent, row: HTMLElement): void {
  card.rows.push({ event, row });
  card.node.title = card.rows.map((r) => r.event.label).join("\n");
}

function newCard(stage: Stage, title: string, sub: string, kind: string, event: LogEvent, row: HTMLElement): Card {
  const titleNode = el("span", { class: "step-title", text: title });
  const subNode = el("span", { class: "step-sub", text: sub });
  const badges = el("span", { class: "step-badges" });
  const node = el("button", { class: `step step-${kind}`, attrs: { type: "button" } }, [
    el("span", { class: "step-stage", text: STAGE_NAMES[stage] }), titleNode, subNode, badges,
  ]);
  const card: Card = { node, title: titleNode, sub: subNode, badges, rows: [] };
  node.addEventListener("click", () => {
    const first = card.rows[0];
    if (first) jump(first.row);
  });
  addRow(card, event, row);
  strip().querySelector(".pipeline-empty")?.remove();
  strip().append(node);
  return card;
}

function badge(card: Card, text: string, kind: "bad" | "warn" | "info"): void {
  card.badges.append(el("span", { class: `step-badge badge-${kind}`, text }));
}

/** "qwen3.5:4b asked for lookup_order · 11 tok/s · 900/8192 tokens" → "asked for lookup_order". */
function responseSummary(label: string): string {
  const body = label.split(" · ")[0] ?? label;
  const space = body.indexOf(" ");
  return space >= 0 ? body.slice(space + 1) : body;
}

/** Turns one log row into a new card, an update to an open card, or nothing. */
function place(e: LogEvent, row: HTMLElement): void {
  if (e.level === "defense") {
    if (e.layer === "tool-permissions" && openTool) {
      // allowed / not-enforced are the normal case; only a decision that changed something gets a badge.
      addRow(openTool, e, row);
      const m = /tool-permissions: (\w+)/.exec(e.label);
      const decision = m?.[1] ?? "";
      if (decision !== "allowed") badge(openTool, decision, decision.startsWith("confirm") ? "info" : "bad");
      return;
    }
    if (!acts(e.label)) return;
    const layer = e.layer ?? "defense";
    const what = e.label.startsWith(`${layer}: `) ? e.label.slice(layer.length + 2) : e.label;
    if (/projected/.test(e.label) && openTool) {
      addRow(openTool, e, row);
      badge(openTool, "projected", "info");
      return;
    }
    if (e.stage === "tool" && openTool) {
      // A tool-stage block (the output filter) stops the call before it is
      // sent, so no result row follows: the block is this card's ending.
      addRow(openTool, e, row);
      openTool.sub.textContent = what;
      openTool.node.classList.remove("step-waiting");
      openTool.node.classList.add("step-defense");
      badge(openTool, `blocked · ${layer}`, "bad");
      openTool = undefined;
      return;
    }
    const stage: Stage = e.stage === "input" ? "input" : e.stage === "model" ? "model" : e.stage === "tool" ? "tool" : "output";
    newCard(stage, layer, what, /projected/.test(e.label) ? "defense-info" : "defense", e, row);
    return;
  }

  if (e.actor === "attacker") {
    newCard("input", "Attack text", e.label, "attacker", e, row);
    return;
  }

  if (e.level === "model") {
    if (e.direction === "out") {
      // "qwen3.5:4b: request 2 — tool loop (structured, no tools)"
      const m = /: request (\d+) — (.+?)( \(structured, no tools\))?$/.exec(e.label);
      const title = m ? `Request ${m[1]} · ${m[2]}` : "Request";
      openRequest = newCard("model", title, "waiting for the model…", "model", e, row);
      openRequest.node.classList.add("step-waiting");
      return;
    }
    if (openRequest) {
      addRow(openRequest, e, row);
      if (e.direction === "in") {
        openRequest.sub.textContent = responseSummary(e.label);
        openRequest.node.classList.remove("step-waiting");
      } else if (/reasoned for/.test(e.label)) {
        badge(openRequest, "reasoned", "info");
      }
    }
    return;
  }

  if (e.level === "tool") {
    if (e.label.startsWith("app loaded ticket")) {
      newCard("input", e.label.replace("app loaded ticket", "Ticket").trim(), "loaded by the app", "input", e, row);
      return;
    }
    if (e.direction === "call") {
      const m = /^call (\w+)\((.*)\)$/.exec(e.label);
      openTool = newCard("tool", m?.[1] ?? "tool call", "running…", "tool", e, row);
      openTool.node.classList.add("step-waiting");
      return;
    }
    if (/delivered the reply/.test(e.label)) {
      newCard("output", "Delivered", e.label.replace("app delivered the reply to ", "to "), "output", e, row);
      return;
    }
    if (/holding message/.test(e.label)) {
      newCard("output", "Holding message", e.label.replace("app sent the holding message to ", "to "), "output-held", e, row);
      return;
    }
    if (e.direction === "back" && openTool) {
      addRow(openTool, e, row);
      const arrow = e.label.indexOf("→ ");
      const text = arrow >= 0 ? e.label.slice(arrow + 2) : e.label;
      openTool.sub.textContent = text;
      openTool.node.classList.remove("step-waiting");
      if (text.startsWith("error")) openTool.node.classList.add("step-error");
      openTool = undefined;
    }
    return;
  }

  if (e.level === "info" && e.label.startsWith("Structured reply")) {
    newCard("output", "Reply", e.label.replace(/^Structured reply:?\s*/, "") || "written", "output", e, row);
    return;
  }
  if (e.level === "warn" && e.label.startsWith("Run stopped")) {
    newCard("output", "Run stopped", e.label.replace(/^Run stopped /, "").split(". The customer")[0] ?? "", "defense", e, row);
    return;
  }
  if (e.level === "error") {
    newCard("output", "Error", e.label, "error", e, row);
  }
}

/** Empties the strip for a new run. */
export function resetPipeline(): void {
  openRequest = undefined;
  openTool = undefined;
  strip().replaceChildren(el("p", { class: "pipeline-empty muted", text: "Press Run: each step of the turn appears here as it happens." }));
}

/** Starts listening to the log. `onJump` shows a log row (the page switches to the log tab first). */
export function initPipeline(onJump: (row: HTMLElement) => void): void {
  jump = onJump;
  resetPipeline();
  onRow((event, row) => place(event, row));
}

/** Adds the scored outcome as the last card. */
export function showOutcome(record: RunRecord): void {
  const o = record.outcome;
  const text = o.kind === "blocked" || o.kind === "falsely-blocked" ? `by ${o.layer} at the ${o.stage} stage` : "";
  const node = el("div", { class: `step step-outcome outcome-${o.kind}` }, [
    el("span", { class: "step-stage", text: STAGE_NAMES.score }),
    el("span", { class: "step-title", text: o.kind }),
    el("span", { class: "step-sub", text }),
  ]);
  strip().querySelector(".pipeline-empty")?.remove();
  strip().append(node);
}
