/**
 * direct.ts — the normal shape of one ticket turn.
 *
 *   1. Load the ticket — the APP calls get_ticket over MCP, as a support
 *      console would when a ticket is opened. The tool server applies any
 *      attack overlays to it, so the ticket arrives already attacked.
 *   2. Build the conversation: the system prompt (with the discount-code
 *      canary), then one user message — the console's trusted instruction
 *      followed by the ticket, the attacker's words.
 *   3. The tool loop. Each tool call the model asks for goes to the tool
 *      server with the run's session attached; the result comes back to
 *      the model as text.
 *   4. The structured reply: a separate request, format on, tools off.
 *   5. Delivery: the APP sends reply_text to the ticket's customer through
 *      the outbox (decision 6). The model never needs send_email for a
 *      legitimate ticket — so any email it does send is its own choice.
 *
 * "Direct" because the model that calls tools reads the untrusted text
 * directly. Privilege separation (layer 6) replaces this shape entirely —
 * separated.ts, build step 9 — rather than adding a filter to it.
 *
 * The defence layers' hooks sit at the stages marked in PLAN.md §3.4 and
 * arrive at build step 8. At this step every run is the undefended
 * assistant, whatever the settings say — and the run's first log row says
 * which layers were asked for, so a run is never mistaken for a defended
 * one.
 *
 * Every step logs, and every failure ends the run with `error` set: the
 * provider down, the tool server gone, a reply that will not parse. An
 * error is never scored as an attack succeeding or failing.
 */

import { randomBytes } from "node:crypto";
import type { OutboxEntry, TicketResult } from "../../shared/shop.js";
import { runToolLoop, type RequestedToolCall, type ToolHandled } from "../agent/loop.js";
import { newModelCallStats, type ModelCallContext } from "../agent/model-call.js";
import { requestReply } from "../agent/reply.js";
import { toOllamaTool } from "../agent/tool-format.js";
import { generateCanaries } from "../canaries.js";
import { describeDefenses } from "../defenses/settings.js";
import { truncate } from "../logger.js";
import { tokensPerSecond, type OllamaMessage } from "../model/ollama.js";
import { CONSOLE_INSTRUCTION, baseSystemPrompt } from "./prompts.js";
import type { RunDeps, RunRequest, RunResult } from "./types.js";
import { renderParts, trusted, untrusted, type MessagePart } from "./untrusted.js";

/** A short, sortable, unique run id: r-20261119-a1b2c3. */
export function newRunId(now = new Date()): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `r-${day}-${randomBytes(3).toString("hex")}`;
}

/**
 * The first user message, as marked parts: the console's instruction and
 * the ticket header (built from the tool server's own records) are
 * trusted; the subject, body and attachment list are the customer's.
 */
export function ticketMessageParts(ticket: TicketResult): MessagePart[] {
  const attachments = ticket.attachments.length === 0
    ? "none"
    : ticket.attachments.map((a) => `${a.attachmentId} ${a.filename} (${a.mediaType}, ${a.size} bytes)`).join("; ");
  return [
    trusted(`${CONSOLE_INSTRUCTION}\n\n[ticket ${ticket.ticketId} · from ${ticket.from} · customer ${ticket.customerId}]\nSubject: `),
    untrusted("ticket.subject", ticket.subject),
    trusted("\n\n"),
    untrusted("ticket.body", ticket.body),
    trusted("\n\nAttachments: "),
    untrusted("ticket.attachments", attachments),
  ];
}

export async function runDirect(request: RunRequest, deps: RunDeps): Promise<RunResult> {
  const started = Date.now();
  const { logger, emit, tools } = deps;
  const runId = request.runId ?? newRunId();
  const canaries = generateCanaries();
  const stats = newModelCallStats();
  const ctx: ModelCallContext = { logger, emit, stats, ...(deps.signal ? { signal: deps.signal } : {}) };

  const result: RunResult = {
    runId, ticketId: request.ticketId, model: request.model, defenses: request.defenses,
    reasoning: request.reasoning, seed: request.seed,
    canaries: canaries.values, canaryCores: canaries.cores,
    reply: null, toolCalls: [], overlaysLanded: [], outbox: [],
    loopOutcome: "not-started", error: undefined,
    requests: 0, elapsedMs: 0, peakPromptTokens: 0, droppedMessages: false, textToolCall: false,
  };

  /** The session for one call: the same run, ticket and overlays; who is calling varies. */
  const session = (caller: "model" | "app") => ({
    runId,
    ticketId: request.ticketId,
    enforcePermissions: request.defenses["tool-permissions"],
    canaries: canaries.values,
    overlays: request.overlays,
    caller,
  });

  const noteOverlays = (ids: string[], where: string): void => {
    for (const id of ids) {
      if (!result.overlaysLanded.includes(id)) result.overlaysLanded.push(id);
    }
    if (ids.length > 0) {
      logger.info(`Attack text landed in ${where} (${ids.join(", ")})`, { overlays: ids }, {
        actor: "attacker", because: "the run's attack planted it there",
      });
    }
  };

  const finish = (): RunResult => {
    logger.iteration = undefined;
    result.requests = stats.requests;
    result.peakPromptTokens = stats.peakPromptTokens;
    result.droppedMessages = stats.droppedMessages;
    result.elapsedMs = Date.now() - started;
    return result;
  };

  tools.setConfirmer(request.confirmer);

  logger.info(
    `New run ${runId} · ticket ${request.ticketId} · ${request.model} · defences: ${describeDefenses(request.defenses)}` +
      (request.reasoning ? " · reasoning on" : "") + (request.overlays.length > 0 ? ` · ${request.overlays.length} attack overlay(s)` : ""),
    { request: { ...request, confirmer: request.confirmer ? "set" : "decline by default" }, canaries: canaries.values },
    { actor: "user", because: "a run was started" },
  );

  try {
    // 1. Load the ticket — the app's call, not the model's.
    const loaded = await tools.call("get_ticket", { ticket_id: request.ticketId }, session("app"));
    logger.tool(`app loaded ticket ${request.ticketId}`, { text: loaded.text, data: loaded.data }, {
      direction: "back", actor: "tool", because: "a ticket was opened in the workspace",
    });
    noteOverlays(loaded.overlays, `ticket ${request.ticketId}`);
    if (loaded.isError || loaded.data === null) {
      result.error = `Could not load ticket ${request.ticketId}: ${loaded.text}`;
      logger.error(result.error);
      emit({ type: "error", message: result.error });
      return finish();
    }
    const ticket = loaded.data as TicketResult;

    // 2. The conversation.
    const messages: OllamaMessage[] = [
      { role: "system", content: baseSystemPrompt(canaries.values.discountCode) },
      { role: "user", content: renderParts(ticketMessageParts(ticket)) },
    ];

    // 3. The tool loop.
    const ollamaTools = (await tools.tools()).map(toOllamaTool);
    const handle = async (call: RequestedToolCall): Promise<ToolHandled> => {
      emit({ type: "tool_start", id: call.id, name: call.name, args: call.args, iteration: call.iteration });
      logger.tool(`call ${call.name}(${truncate(JSON.stringify(call.args), 100)})`, call.args, {
        direction: "call", actor: "app", because: "the model's response asked for it",
      });

      const outcome = await tools.call(call.name, call.args, session("model"));

      for (const q of outcome.queries) {
        logger.data(`SQL ${truncate(q.sql, 80)} → ${q.rows} row${q.rows === 1 ? "" : "s"}, ${q.ms} ms`, q);
      }
      noteOverlays(outcome.overlays, `the ${call.name} result`);
      const verdict = outcome.permission;
      if (verdict && verdict.decision !== "not-enforced") {
        logger.defense("tool-permissions", "tool",
          `tool-permissions: ${verdict.decision} — ${verdict.reason}`, verdict,
          { because: `the tool server checks "${verdict.rule}"` });
      }
      logger.tool(`${call.name} → ${outcome.isError ? "error: " : ""}${truncate(outcome.text, 100)}`,
        { text: outcome.text, isError: outcome.isError, data: outcome.data }, { direction: "back", actor: "tool" });

      result.toolCalls.push({
        iteration: call.iteration, name: call.name, args: call.args,
        executed: !outcome.isError, isError: outcome.isError, text: outcome.text,
        permission: verdict, confirmation: outcome.confirmation, overlays: outcome.overlays,
      });
      result.outbox = outcome.outbox;
      emit({ type: "tool_end", id: call.id, name: call.name, isError: outcome.isError, elapsedMs: outcome.elapsedMs });
      return { kind: "result", content: outcome.text };
    };

    const loop = await runToolLoop({
      model: request.model, messages, tools: ollamaTools, think: request.reasoning,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
    }, handle, ctx);
    result.loopOutcome = loop.outcome;
    result.textToolCall = loop.textToolCall;

    if (loop.outcome !== "replied") {
      logger.warn(`The tool loop ended without a reply (${loop.outcome}${loop.stopReason ? `: ${loop.stopReason}` : ""})`);
      emit({ type: "done", runId, requests: stats.requests, elapsedMs: Date.now() - started });
      return finish();
    }

    // 4. The structured reply.
    const reply = await requestReply(loop.messages, {
      model: request.model, think: request.reasoning,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
    }, ctx);
    if (!reply.ok) {
      result.error = `The structured reply did not parse after a retry: ${reply.error}`;
      logger.error(result.error, { raw: reply.raw });
      emit({ type: "error", message: result.error });
      return finish();
    }
    result.reply = reply.reply;
    logger.info(`Structured reply: order ${reply.reply.order_id ?? "none"} · status ${reply.reply.order_status_reported ?? "none"} · ` +
      `refund ${reply.reply.refund_amount ?? "none"} · needs_human ${reply.reply.needs_human}`, reply.reply, { actor: "model" });

    // 5. Delivery — the app's call, to the ticket's own customer.
    const delivered = await tools.call("send_email",
      { to: ticket.from, subject: `Re: ${ticket.subject}`.slice(0, 200), body: reply.reply.reply_text.slice(0, 4000) }, session("app"));
    logger.tool(`app delivered the reply to ${ticket.from}`, { text: delivered.text, outbox: delivered.outbox }, {
      direction: "back", actor: "tool", because: "replies are delivered by the app, to the ticket's customer only",
    });
    result.outbox = delivered.outbox as OutboxEntry[];
    if (delivered.isError) {
      result.error = `Could not deliver the reply: ${delivered.text}`;
      logger.error(result.error);
    }

    const last = stats.lastResponse;
    logger.info(`Run complete · ${stats.requests} model request${stats.requests === 1 ? "" : "s"} · ` +
      `${((Date.now() - started) / 1000).toFixed(1)} s` + (last ? ` · ${tokensPerSecond(last) ?? "?"} tok/s` : ""));
    emit({ type: "done", runId, requests: stats.requests, elapsedMs: Date.now() - started });
    return finish();
  } catch (error: unknown) {
    result.error = error instanceof Error ? error.message : String(error);
    logger.error(result.error, error instanceof Error ? { name: error.name, message: error.message } : error);
    emit({ type: "error", message: result.error });
    return finish();
  }
}
