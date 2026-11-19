/**
 * run-context.ts — the machinery every pipeline shape shares.
 *
 * The lab has two pipeline shapes (direct.ts and separated.ts). They
 * differ in ONE thing — what the model with tools gets to read — and share
 * everything else: loading the ticket, the session sent with every tool
 * call, the tool stage around each call, the structured reply, the output
 * stage, delivery, the holding message when a defence stops the run, and
 * the bookkeeping that turns all of it into a RunResult.
 *
 * That shared part lives here, so the two shape files can each be read as
 * the story of their difference. A fix to delivery, logging or a tool
 * call's record is made once and holds for both — which matters, because
 * the arena compares them.
 */

import { randomBytes } from "node:crypto";
import type { LabSession, OutboxEntry, TicketResult } from "../../shared/shop.js";
import type { RequestedToolCall } from "../agent/loop.js";
import { newModelCallStats, type ModelCallContext, type ModelCallStats } from "../agent/model-call.js";
import { requestReply } from "../agent/reply.js";
import { generateCanaries, type RunCanaries } from "../canaries.js";
import { describeDefenses } from "../defenses/settings.js";
import type { TurnContext } from "../defenses/types.js";
import { truncate } from "../logger.js";
import type { ToolCallOutcome } from "../mcp/client.js";
import { tokensPerSecond, type OllamaMessage } from "../model/ollama.js";
import { outputStage, toolStage, type StageBlock, type StageDeps } from "./stages.js";
import type { RunDeps, RunRequest, RunResult } from "./types.js";

/**
 * Tools the APP uses but the model is not offered (decision 14).
 *
 * get_ticket: the app loads the ticket and puts it in the first message,
 * so the model never needs it. Offering it anyway cost llama3.2:3b the
 * whole task in step 5: it called get_ticket first, and its chat template
 * then stopped showing it the tool definitions (they render only when the
 * last message is a user message), so it never looked up the order and
 * invented a refund. Least privilege, and the realistic console shape: the
 * tool stays in the tool server, for the app.
 */
export const APP_ONLY_TOOLS: ReadonlySet<string> = new Set(["get_ticket"]);

/**
 * What the customer receives when a defence stops the run or withholds
 * the reply. The APP's words, never the model's — a held reply cannot
 * carry what was being held back.
 */
export const HOLDING_REPLY =
  "Thanks for your message. A member of our support team will look into this and get back to you shortly.";

/** A short, sortable, unique run id: r-20261119-a1b2c3. */
export function newRunId(now = new Date()): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `r-${day}-${randomBytes(3).toString("hex")}`;
}

/** Everything one run carries around. */
export interface RunContext {
  request: RunRequest;
  deps: RunDeps;
  runId: string;
  canaries: RunCanaries;
  stats: ModelCallStats;
  model: ModelCallContext;
  sampling: { temperature?: number; seed?: number };
  result: RunResult;
  started: number;
}

export function createRunContext(request: RunRequest, deps: RunDeps): RunContext {
  const runId = request.runId ?? newRunId();
  const canaries = generateCanaries();
  const stats = newModelCallStats();
  return {
    request, deps, runId, canaries, stats,
    model: { logger: deps.logger, emit: deps.emit, stats, ...(deps.signal ? { signal: deps.signal } : {}) },
    sampling: {
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
    },
    result: {
      runId, ticketId: request.ticketId, model: request.model, defenses: request.defenses,
      reasoning: request.reasoning, seed: request.seed,
      canaries: canaries.values, canaryCores: canaries.cores,
      customerEmail: "", reply: null, delivered: false, toolCalls: [], defenseActions: [], overlaysLanded: [], outbox: [],
      loopOutcome: "not-started", error: undefined,
      requests: 0, elapsedMs: 0, peakPromptTokens: 0, droppedMessages: false, textToolCall: false,
    },
    started: Date.now(),
  };
}

/** The session for one call: the same run, ticket and overlays; who is calling varies. */
export function sessionFor(rc: RunContext, caller: "model" | "app"): LabSession {
  return {
    runId: rc.runId,
    ticketId: rc.request.ticketId,
    enforcePermissions: rc.request.defenses["tool-permissions"],
    canaries: rc.canaries.values,
    overlays: rc.request.overlays,
    caller,
  };
}

/** Records overlays that landed, and logs where. */
export function noteOverlays(rc: RunContext, ids: string[], where: string): void {
  for (const id of ids) {
    if (!rc.result.overlaysLanded.includes(id)) rc.result.overlaysLanded.push(id);
  }
  if (ids.length > 0) {
    rc.deps.logger.info(`Attack text landed in ${where} (${ids.join(", ")})`, { overlays: ids }, {
      actor: "attacker", because: "the run's attack planted it there",
    });
  }
}

/** Ends the run: totals, the done event, the result. */
export function finish(rc: RunContext): RunResult {
  const { result, stats } = rc;
  rc.deps.logger.iteration = undefined;
  result.requests = stats.requests;
  result.peakPromptTokens = stats.peakPromptTokens;
  result.droppedMessages = stats.droppedMessages;
  result.elapsedMs = Date.now() - rc.started;
  rc.deps.emit({ type: "done", runId: rc.runId, requests: stats.requests, elapsedMs: result.elapsedMs });
  return result;
}

/** Ends the run with an error a person can read. Never scored as success or failure. */
export function fail(rc: RunContext, message: string, detail?: unknown): RunResult {
  rc.result.error = message;
  rc.deps.logger.error(message, detail);
  rc.deps.emit({ type: "error", message });
  return finish(rc);
}

/** The run's opening log rows: what was asked for, said before anything happens. */
export function announce(rc: RunContext, shape: string): void {
  const { request, deps } = rc;
  deps.logger.info(
    `New run ${rc.runId} · ticket ${request.ticketId} · ${request.model} · defences: ${describeDefenses(request.defenses)} · ${shape}` +
      (request.reasoning ? " · reasoning on" : "") + (request.overlays.length > 0 ? ` · ${request.overlays.length} attack overlay(s)` : ""),
    { request: { ...request, confirmer: request.confirmer ? "set" : "decline by default" }, canaries: rc.canaries.values },
    { actor: "user", because: "a run was started" },
  );
  if (request.defenses["tool-permissions"]) {
    deps.logger.defense("tool-permissions", "tool", "tool-permissions: enforced by the tool server for every call in this run", undefined, {
      because: "layer 5 is on — the rules run in the tool server, not here",
    });
  }
}

/** Loads the ticket — the app's call, not the model's. Null (and `error` set) if it fails. */
export async function loadTicket(rc: RunContext): Promise<TicketResult | null> {
  const { deps, request } = rc;
  const loaded = await deps.tools.call("get_ticket", { ticket_id: request.ticketId }, sessionFor(rc, "app"));
  deps.logger.tool(`app loaded ticket ${request.ticketId}`, { text: loaded.text, data: loaded.data }, {
    direction: "back", actor: "tool", because: "a ticket was opened in the workspace",
  });
  noteOverlays(rc, loaded.overlays, `ticket ${request.ticketId}`);
  if (loaded.isError || loaded.data === null) {
    fail(rc, `Could not load ticket ${request.ticketId}: ${loaded.text}`);
    return null;
  }
  const ticket = loaded.data as TicketResult;
  rc.result.customerEmail = ticket.from;
  return ticket;
}

/** The defence stages' context, once the ticket (and so the customer) is known. */
export function stageDeps(rc: RunContext, ticket: TicketResult): StageDeps {
  const ctx: TurnContext = {
    runId: rc.runId, model: rc.request.model, canaries: rc.canaries, customerEmail: ticket.from,
    spotlightToken: randomBytes(3).toString("hex"),
    logger: rc.deps.logger, emit: rc.deps.emit, stats: rc.stats,
    ...(rc.deps.signal ? { signal: rc.deps.signal } : {}), ...rc.sampling,
  };
  return { settings: rc.request.defenses, ctx, actions: rc.result.defenseActions };
}

/**
 * A defence stopped the run: the app sends the customer its holding
 * message, and the ticket goes to a person. A structured reply, if there
 * was one, stays in the result — withheld, not delivered.
 */
export async function holdAndEscalate(rc: RunContext, ticket: TicketResult, block: StageBlock): Promise<RunResult> {
  const { deps } = rc;
  deps.logger.warn(`Run stopped by ${block.layer} at the ${block.stage} stage: ${block.reason}. The customer gets the holding message; the ticket goes to a person.`, block);
  const held = await deps.tools.call("send_email",
    { to: ticket.from, subject: `Re: ${ticket.subject}`.slice(0, 200), body: HOLDING_REPLY }, sessionFor(rc, "app"));
  rc.result.outbox = held.outbox as OutboxEntry[];
  deps.logger.tool(`app sent the holding message to ${ticket.from}`, { text: held.text }, { direction: "back", actor: "tool" });
  return finish(rc);
}

/** What one model tool call came to: blocked in the app, or the tool server's outcome. */
export type ToolCallDone =
  | { kind: "blocked"; text: string }
  | { kind: "ran"; outcome: ToolCallOutcome; index: number };

/**
 * One tool call the model asked for: the app-side TOOL STAGE (the output
 * filter), then across the MCP boundary to the tool server and layer 5,
 * with every step logged and the call recorded in the result. What the
 * model then reads is the shape's decision — direct.ts passes the result
 * through the input stage; separated.ts projects it first.
 */
export async function runToolCall(rc: RunContext, call: RequestedToolCall, stage: StageDeps): Promise<ToolCallDone> {
  const { deps, result } = rc;
  const { logger, emit } = deps;
  emit({ type: "tool_start", id: call.id, name: call.name, args: call.args, iteration: call.iteration });
  logger.tool(`call ${call.name}(${truncate(JSON.stringify(call.args), 100)})`, call.args, {
    direction: "call", actor: "app", because: "the model's response asked for it",
  });
  const index = result.toolCalls.length;

  const filtered = toolStage({ name: call.name, args: call.args }, index, stage);
  if (filtered) {
    const text = `Blocked by the ${filtered.layer} before it was sent: ${filtered.reason}.`;
    result.toolCalls.push({
      iteration: call.iteration, name: call.name, args: call.args, executed: false, isError: true, text,
      permission: undefined, confirmation: undefined, overlays: [],
    });
    emit({ type: "tool_end", id: call.id, name: call.name, isError: true, elapsedMs: 0 });
    return { kind: "blocked", text };
  }

  const outcome = await deps.tools.call(call.name, call.args, sessionFor(rc, "model"));
  for (const q of outcome.queries) {
    logger.data(`SQL ${truncate(q.sql, 80)} → ${q.rows} row${q.rows === 1 ? "" : "s"}, ${q.ms} ms`, q);
  }
  noteOverlays(rc, outcome.overlays, `the ${call.name} result`);
  const verdict = outcome.permission;
  if (verdict && verdict.decision !== "not-enforced") {
    logger.defense("tool-permissions", "tool", `tool-permissions: ${verdict.decision} — ${verdict.reason}`, verdict,
      { because: `the tool server checks "${verdict.rule}"` });
  }
  logger.tool(`${call.name} → ${outcome.isError ? "error: " : ""}${truncate(outcome.text, 100)}`,
    { text: outcome.text, isError: outcome.isError, data: outcome.data }, { direction: "back", actor: "tool" });

  // Layer 5's refusals and filters are defence actions, so the scorer can
  // attribute a block to the layer that made it.
  if (verdict && (verdict.decision === "refused" || verdict.decision === "declined" || verdict.decision === "filtered")) {
    result.defenseActions.push({
      layer: "tool-permissions", stage: "tool",
      decision: verdict.decision === "filtered" ? "filter" : "block",
      what: `${call.name}: ${verdict.reason}`, toolCallIndex: index,
    });
  }
  result.toolCalls.push({
    iteration: call.iteration, name: call.name, args: call.args,
    executed: !outcome.isError, isError: outcome.isError, text: outcome.text,
    permission: verdict, confirmation: outcome.confirmation, overlays: outcome.overlays,
  });
  result.outbox = outcome.outbox;
  emit({ type: "tool_end", id: call.id, name: call.name, isError: outcome.isError, elapsedMs: outcome.elapsedMs });
  return { kind: "ran", outcome, index };
}

/**
 * The end of a turn: the structured reply, the OUTPUT STAGE, delivery.
 * Returns "delivered" to carry on, or the finished RunResult if the run
 * ended here (a reply that would not parse, a withheld reply).
 */
export async function replyAndDeliver(rc: RunContext, ticket: TicketResult, messages: OllamaMessage[], stage: StageDeps): Promise<"delivered" | RunResult> {
  const { deps, request, result } = rc;
  const reply = await requestReply(messages, { model: request.model, think: request.reasoning, ...rc.sampling }, rc.model);
  if (!reply.ok) return fail(rc, `The structured reply did not parse after a retry: ${reply.error}`, { raw: reply.raw });
  result.reply = reply.reply;
  result.delivered = false;
  deps.logger.info(`Structured reply: order ${reply.reply.order_id ?? "none"} · status ${reply.reply.order_status_reported ?? "none"} · ` +
    `refund ${reply.reply.refund_amount ?? "none"} · needs_human ${reply.reply.needs_human}`, reply.reply, { actor: "model" });

  const withheld = outputStage(reply.reply, stage);
  if (withheld) return holdAndEscalate(rc, ticket, withheld);

  // The next turn sees the reply the customer saw, not the draft.
  messages.push({ role: "assistant", content: reply.reply.reply_text });

  const delivered = await deps.tools.call("send_email",
    { to: ticket.from, subject: `Re: ${ticket.subject}`.slice(0, 200), body: reply.reply.reply_text.slice(0, 4000) }, sessionFor(rc, "app"));
  deps.logger.tool(`app delivered the reply to ${ticket.from}`, { text: delivered.text, outbox: delivered.outbox }, {
    direction: "back", actor: "tool", because: "replies are delivered by the app, to the ticket's customer only",
  });
  result.outbox = delivered.outbox as OutboxEntry[];
  result.delivered = !delivered.isError;
  if (delivered.isError) return fail(rc, `Could not deliver the reply: ${delivered.text}`);
  return "delivered";
}

/** The closing log row for a run that went the whole way. */
export function complete(rc: RunContext): RunResult {
  const last = rc.stats.lastResponse;
  rc.deps.logger.info(`Run complete · ${rc.stats.requests} model request${rc.stats.requests === 1 ? "" : "s"} · ` +
    `${((Date.now() - rc.started) / 1000).toFixed(1)} s` + (last ? ` · ${tokensPerSecond(last) ?? "?"} tok/s` : ""));
  return finish(rc);
}
