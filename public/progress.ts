/**
 * progress.ts — shows that a run is in progress, and what it is waiting for.
 *
 * A local model can take a minute or more to finish a ticket: several
 * requests at ten-odd tokens a second, plus the classifier and the
 * quarantined reader when those layers are on. Without a sign of life the
 * page looks frozen. So, beside the Run button, while a run is going:
 *
 *   - a spinner and the elapsed time, ticking every second
 *   - the CURRENT STEP, read from the run's own events as they stream in:
 *     "Waiting for qwen3.5:4b — request 2 (tool loop)", "Running tool
 *     lookup_order…", "Waiting for your answer in the dialog…"
 *
 * The step text comes from the same log rows the activity log shows, so it
 * never claims something the log does not. When the run ends, the line
 * says how — done, stopped by you, or failed — and how long it took.
 */

import { byId } from "./dom.js";
import type { LogEvent } from "./types.js";

let started = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let step = "";

function seconds(): string {
  const s = Math.floor((Date.now() - started) / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

function draw(running: boolean): void {
  const node = byId("run-status");
  node.classList.toggle("running", running);
  byId("run-status-text").textContent = step;
  byId("run-status-time").textContent = started ? seconds() : "";
}

/** A run has started. */
export function startProgress(): void {
  started = Date.now();
  step = "Starting the run…";
  if (timer) clearInterval(timer);
  timer = setInterval(() => draw(true), 1000);
  byId("run-status").hidden = false;
  draw(true);
}

/** Sets the current step directly (the confirmation dialog uses this). */
export function setStep(text: string): void {
  step = text;
  draw(true);
}

/** Reads one log row and, if it marks a new step, shows it. */
export function stepFromLog(e: LogEvent): void {
  let next: string | undefined;
  if (e.level === "model" && e.direction === "out") {
    // "qwen3.5:4b: request 2 — tool loop" → "Waiting for qwen3.5:4b — request 2 (tool loop)"
    const m = /^(.+?): request (\d+) — (.+?)( \(structured, no tools\))?$/.exec(e.label);
    next = m ? `Waiting for ${m[1]} — request ${m[2]} (${m[3]})` : `Waiting for the model…`;
  } else if (e.level === "model" && e.direction === "in") {
    next = "Reply received — reading it…";
  } else if (e.level === "tool" && e.direction === "call") {
    const m = /^call (\w+)\(/.exec(e.label);
    next = `Running tool ${m?.[1] ?? ""}…`;
  } else if (e.level === "tool" && e.label.startsWith("app loaded ticket")) {
    next = "Ticket loaded — preparing the first request…";
  } else if (e.level === "tool" && e.label.startsWith("app delivered")) {
    next = "Delivering the reply to the customer…";
  } else if (e.level === "warn" && e.label.startsWith("Run stopped")) {
    next = "Stopped by a defense — sending the holding message…";
  }
  if (next) setStep(next);
}

/** The run is over: say how, and how long it took. */
export function stopProgress(how: "done" | "stopped" | "failed"): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  const took = seconds();
  step = how === "done" ? `Done in ${took}` : how === "stopped" ? `Stopped after ${took}` : `Failed after ${took}`;
  started = 0;
  draw(false);
}
