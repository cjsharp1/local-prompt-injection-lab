/**
 * app.ts — wires the page together. Nothing imports this file.
 *
 * On load: fetch the models, layers and stacks (/api/meta) and the attack
 * library (/api/library), draw the studio, the defence panel and the
 * pipeline view, and preview the default ticket.
 *
 * Run: POST /api/run with the selected attack (or benign ticket), the
 * defence switches, the model and the reasoning switch. While it runs, the
 * Run button becomes Stop and progress.ts shows the elapsed time and the
 * current step. Stop aborts the request; the server notices the closed
 * connection and stops asking the model. The response is a stream of
 * Server-Sent Events, read here line by line:
 *
 *   log       → a row in the activity log (and a card in the pipeline view)
 *   confirm   → the confirmation dialog; the answer goes to /api/confirm
 *   result    → the workspace's reply, outbox and outcome badge
 *   error     → the banner
 *
 * The import graph runs one way: this file imports the panels; the panels
 * import dom.ts, state.ts and log.ts; nothing imports app.ts.
 */

import { askPerson } from "./confirm.js";
import { renderDefenses } from "./defenses.js";
import { byId, el } from "./dom.js";
import { appendLog, clearLog, logDivider } from "./log.js";
import { initPipeline, resetPipeline, showOutcome } from "./pipeline.js";
import { setStep, startProgress, stepFromLog, stopProgress } from "./progress.js";
import { renderResults } from "./results.js";
import { selectedAttack, state } from "./state.js";
import { initEditor, renderLanding, renderPicker } from "./studio.js";
import type { LibraryResponse, MetaResponse, PreviewResponse, StreamEvent } from "./types.js";
import { clearRecord, renderRecord, renderTicket, showWaiting } from "./workspace.js";

/** Aborts the run in progress, when Stop is pressed. */
let runAbort: AbortController | undefined;

/** Run ↔ Stop: the same button, so there is always one obvious thing to press. */
function setRunButton(running: boolean): void {
  const button = byId<HTMLButtonElement>("run");
  button.textContent = running ? "Stop" : "Run";
  button.classList.toggle("stop", running);
}

function banner(message: string | undefined): void {
  const node = byId("banner");
  node.hidden = message === undefined;
  node.textContent = message ?? "";
}

/** What to send for the current selection. */
function itemBody(): Record<string, unknown> {
  if (state.customAttack !== undefined) return { attack: state.customAttack };
  if (state.attackId) return { attackId: state.attackId };
  return { benignId: state.benignId };
}

async function preview(): Promise<void> {
  try {
    const response = await fetch("/api/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(itemBody()) });
    const data = await response.json() as PreviewResponse & { error?: string };
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
    banner(undefined);
    renderTicket(data);
    renderLanding(data);
  } catch (error: unknown) {
    banner(error instanceof Error ? error.message : String(error));
  }
}

function showTab(name: string): void {
  for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
    const on = tab.dataset.tab === name;
    tab.classList.toggle("active", on);
    byId(`tab-${tab.dataset.tab ?? ""}`).hidden = !on;
  }
  if (name === "results") void renderResults();
}

async function run(): Promise<void> {
  if (state.running) {
    runAbort?.abort();
    return;
  }
  state.running = true;
  runAbort = new AbortController();
  setRunButton(true);
  startProgress();
  banner(undefined);
  showWaiting();
  resetPipeline();
  const a = state.customAttack !== undefined ? "your attack" : selectedAttack()?.title ?? `benign ${state.benignId}`;
  logDivider(`${a} · ${state.model} · stack ${state.stack}`);
  showTab("workspace");

  try {
    const response = await fetch("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...itemBody(), model: state.model, reasoning: state.reasoning, defenses: state.defenses }),
      signal: runAbort.signal,
    });
    if (!response.ok || !response.body) {
      const data = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(data.error ?? `HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // One SSE event per blank-line-separated block.
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const line = raw.split("\n").find((l) => l.startsWith("data: "));
        if (line) handle(JSON.parse(line.slice(6)) as StreamEvent);
      }
    }
    stopProgress(state.lastRecord?.outcome.kind === "error" ? "failed" : "done");
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") {
      stopProgress("stopped");
      clearRecord();
    } else {
      stopProgress("failed");
      banner(error instanceof Error ? error.message : String(error));
    }
  } finally {
    state.running = false;
    runAbort = undefined;
    setRunButton(false);
  }
}

function handle(event: StreamEvent): void {
  switch (event.type) {
    case "log":
      appendLog(event.event);
      stepFromLog(event.event);
      return;
    case "confirm":
      setStep("Waiting for your answer in the dialog…");
      void askPerson(event.message).then((allow) => {
        setStep(allow ? "Allowed — the tool is running…" : "Declined — carrying on without it…");
        return fetch("/api/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: event.id, allow }) });
      });
      return;
    case "result":
      setStep("Scoring the run…");
      state.lastRecord = event.record;
      renderRecord(event.record);
      showOutcome(event.record);
      return;
    case "error":
      banner(event.message);
      return;
    default:
      // reasoning, tool_start, tool_end, done: the log already shows them.
      return;
  }
}

function renderModels(meta: MetaResponse): void {
  const select = byId<HTMLSelectElement>("model-select");
  select.replaceChildren(...meta.models.map((m) => el("option", { text: `${m.name} (${m.parameterSize})`, attrs: { value: m.name } })));
  state.model = meta.models.some((m) => m.name === meta.defaultModel) ? meta.defaultModel : meta.models[0]?.name ?? "";
  select.value = state.model;
  const reasoning = byId<HTMLInputElement>("reasoning");
  const sync = () => {
    const can = meta.models.find((m) => m.name === state.model)?.supportsThinking === true;
    reasoning.disabled = !can;
    if (!can) reasoning.checked = false;
    state.reasoning = reasoning.checked;
    byId("reasoning-label").title = can
      ? "Reasoning is more generated text, not proof of why the model acted."
      : `${state.model} cannot show its reasoning (no "thinking" capability).`;
  };
  select.addEventListener("change", () => { state.model = select.value; sync(); });
  reasoning.addEventListener("change", sync);
  sync();
}

async function main(): Promise<void> {
  initPipeline();
  clearRecord();
  for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
    tab.addEventListener("click", () => showTab(tab.dataset.tab ?? "studio"));
  }
  byId("run").addEventListener("click", () => void run());
  byId("clear-log").addEventListener("click", () => clearLog());
  byId("reveal-toggle").addEventListener("change", () => void preview());

  try {
    const [meta, library] = await Promise.all([
      fetch("/api/meta").then(async (r) => { if (!r.ok) throw new Error((await r.json() as { error?: string }).error ?? "meta"); return r.json() as Promise<MetaResponse>; }),
      fetch("/api/library").then((r) => r.json() as Promise<LibraryResponse>),
    ]);
    state.meta = meta;
    state.attacks = library.attacks;
    state.benign = library.benign;
    renderModels(meta);
    renderDefenses(() => {});
    const reselect = () => { renderPicker(reselect); void preview(); };
    renderPicker(reselect);
    initEditor((attack) => {
      state.customAttack = attack;
      void preview();
    }, (message) => banner(message));
    void preview();
  } catch (error: unknown) {
    banner(`Could not start: ${error instanceof Error ? error.message : String(error)}. Is Ollama running? Try npm run check-env.`);
  }
}

void main();
