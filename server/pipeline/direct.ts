/**
 * direct.ts — the normal shape of one ticket turn, with every defence stage marked.
 *
 *   1. Load the ticket — the APP calls get_ticket over MCP, as a support
 *      console would when a ticket is opened. The tool server applies any
 *      attack overlays to it, so the ticket arrives already attacked.
 *   2. MODEL STAGE: the system prompt (with the discount-code canary),
 *      through the hardened prompt and spotlighting's marker sentence.
 *   3. INPUT STAGE: each untrusted chunk of the first message — the
 *      ticket, the live-chat message — is fenced (spotlighting) and read by
 *      the classifier. A flag ends the run before the model sees anything.
 *   4. The tool loop. For each tool call the model asks for:
 *        TOOL STAGE  the output filter checks the arguments, in this
 *                    process; then, across the MCP boundary, the tool
 *                    server's permission rules (layer 5)
 *        INPUT STAGE the result is fenced and classified before the model
 *                    reads it; a flag ends the turn
 *   5. The structured reply: a separate request, format on, tools off.
 *   6. OUTPUT STAGE: the output filter checks the reply. A block withholds
 *      it, and the customer gets a holding message instead.
 *   7. Delivery: the APP sends reply_text to the ticket's customer through
 *      the outbox (decision 6). The model never needs send_email for a
 *      legitimate ticket — so any email it does send is its own choice.
 *
 * "Direct" because the model that calls tools reads the untrusted text —
 * fenced or not — directly. Privilege separation (layer 6) replaces this
 * shape entirely rather than adding a filter to it (separated.ts).
 *
 * The layers themselves know nothing about this file. Each stage calls
 * stages.ts, which runs whichever layers are on, logs every decision and
 * records every block, so the same code runs the undefended assistant and
 * the fully defended one.
 *
 * Every failure ends the run with `error` set: the provider down, the tool
 * server gone, a reply that will not parse. An error is never scored as an
 * attack succeeding or failing.
 */

import { randomBytes } from "node:crypto";
import type { OutboxEntry, TicketResult } from "../../shared/shop.js";
import { runToolLoop, type RequestedToolCall, type ToolHandled } from "../agent/loop.js";
import { newModelCallStats, type ModelCallContext } from "../agent/model-call.js";
import { requestReply } from "../agent/reply.js";
import { toOllamaTool } from "../agent/tool-format.js";
import { generateCanaries } from "../canaries.js";
import { describeDefenses } from "../defenses/settings.js";
import type { TurnContext } from "../defenses/types.js";
import { truncate } from "../logger.js";
import { tokensPerSecond, type OllamaMessage } from "../model/ollama.js";
import { CONSOLE_INSTRUCTION, baseSystemPrompt } from "./prompts.js";
import { inputStage, outputStage, systemPromptStage, toolStage, type StageBlock, type StageDeps } from "./stages.js";
import type { RunDeps, RunRequest, RunResult } from "./types.js";
import { renderParts, trusted, untrusted, type MessagePart } from "./untrusted.js";

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

/** The ticket's untrusted text, as one block: what the customer controls. */
export function ticketBlock(ticket: TicketResult): string {
  const attachments = ticket.attachments.length === 0
    ? "none"
    : ticket.attachments.map((a) => `${a.attachmentId} ${a.filename} (${a.mediaType}, ${a.size} bytes)`).join("; ");
  return `Subject: ${ticket.subject}\n\n${ticket.body}\n\nAttachments: ${attachments}`;
}

/**
 * The first user message, as marked parts: the console's instruction and
 * the ticket header (built from the tool server's own records) are
 * trusted; the ticket block and any live-chat message are the customer's.
 */
export function ticketMessageParts(ticket: TicketResult, chatMessage?: string): MessagePart[] {
  return [
    trusted(`${CONSOLE_INSTRUCTION}\n\n[ticket ${ticket.ticketId} · from ${ticket.from} · customer ${ticket.customerId}]\n`),
    untrusted("ticket", ticketBlock(ticket)),
    // The "direct" channel: the customer typing to the assistant in a live
    // chat beside the ticket. Untrusted for the same reason the ticket is.
    ...(chatMessage === undefined ? [] : [trusted("\n\nThe customer also wrote in the live chat:\n"), untrusted("user_turn", chatMessage)]),
  ];
}

export async function runDirect(request: RunRequest, deps: RunDeps): Promise<RunResult> {
  const started = Date.now();
  const { logger, emit, tools } = deps;
  const runId = request.runId ?? newRunId();
  const canaries = generateCanaries();
  const stats = newModelCallStats();
  const ctx: ModelCallContext = { logger, emit, stats, ...(deps.signal ? { signal: deps.signal } : {}) };
  const sampling = {
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
  };

  const result: RunResult = {
    runId, ticketId: request.ticketId, model: request.model, defenses: request.defenses,
    reasoning: request.reasoning, seed: request.seed,
    canaries: canaries.values, canaryCores: canaries.cores,
    customerEmail: "", reply: null, delivered: false, toolCalls: [], defenseActions: [], overlaysLanded: [], outbox: [],
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
    emit({ type: "done", runId, requests: stats.requests, elapsedMs: result.elapsedMs });
    return result;
  };

  const fail = (message: string, detail?: unknown): RunResult => {
    result.error = message;
    logger.error(message, detail);
    emit({ type: "error", message });
    return finish();
  };

  tools.setConfirmer(request.confirmer);

  logger.info(
    `New run ${runId} · ticket ${request.ticketId} · ${request.model} · defences: ${describeDefenses(request.defenses)}` +
      (request.reasoning ? " · reasoning on" : "") + (request.overlays.length > 0 ? ` · ${request.overlays.length} attack overlay(s)` : ""),
    { request: { ...request, confirmer: request.confirmer ? "set" : "decline by default" }, canaries: canaries.values },
    { actor: "user", because: "a run was started" },
  );
  if (request.defenses["tool-permissions"]) {
    logger.defense("tool-permissions", "tool", "tool-permissions: enforced by the tool server for every call in this run", undefined, {
      because: "layer 5 is on — the rules run in the tool server, not here",
    });
  }

  try {
    // 1. Load the ticket — the app's call, not the model's.
    const loaded = await tools.call("get_ticket", { ticket_id: request.ticketId }, session("app"));
    logger.tool(`app loaded ticket ${request.ticketId}`, { text: loaded.text, data: loaded.data }, {
      direction: "back", actor: "tool", because: "a ticket was opened in the workspace",
    });
    noteOverlays(loaded.overlays, `ticket ${request.ticketId}`);
    if (loaded.isError || loaded.data === null) return fail(`Could not load ticket ${request.ticketId}: ${loaded.text}`);
    const ticket = loaded.data as TicketResult;
    result.customerEmail = ticket.from;

    const turnCtx: TurnContext = {
      runId, model: request.model, canaries, customerEmail: ticket.from,
      spotlightToken: randomBytes(3).toString("hex"),
      logger, emit, stats, ...(deps.signal ? { signal: deps.signal } : {}), ...sampling,
    };
    const stage: StageDeps = { settings: request.defenses, ctx: turnCtx, actions: result.defenseActions };

    /**
     * A defence stopped the run: the app sends the customer its holding
     * message, and the ticket goes to a person. The structured reply, if
     * there was one, is kept in the result — withheld, not delivered.
     */
    const holdAndEscalate = async (block: StageBlock): Promise<RunResult> => {
      logger.warn(`Run stopped by ${block.layer} at the ${block.stage} stage: ${block.reason}. The customer gets the holding message; the ticket goes to a person.`, block);
      const held = await tools.call("send_email",
        { to: ticket.from, subject: `Re: ${ticket.subject}`.slice(0, 200), body: HOLDING_REPLY }, session("app"));
      result.outbox = held.outbox as OutboxEntry[];
      logger.tool(`app sent the holding message to ${ticket.from}`, { text: held.text }, { direction: "back", actor: "tool" });
      return finish();
    };

    // 2. MODEL STAGE — the system prompt.
    const systemPrompt = systemPromptStage(baseSystemPrompt(canaries.values.discountCode), stage);

    // 3. INPUT STAGE — the first message's untrusted parts.
    const parts = ticketMessageParts(ticket, request.chatMessage);
    for (const part of parts) {
      if (part.trust !== "untrusted") continue;
      const checked = await inputStage({ source: part.source ?? "untrusted", text: part.text }, stage);
      if (checked.block) {
        result.loopOutcome = "stopped";
        return holdAndEscalate(checked.block);
      }
      part.text = checked.chunk.text;
    }
    const messages: OllamaMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: renderParts(parts) },
    ];

    // 4. The tool loop, with the tool and input stages around each call.
    const ollamaTools = (await tools.tools()).filter((t) => !APP_ONLY_TOOLS.has(t.name)).map(toOllamaTool);
    const handle = async (call: RequestedToolCall): Promise<ToolHandled> => {
      emit({ type: "tool_start", id: call.id, name: call.name, args: call.args, iteration: call.iteration });
      logger.tool(`call ${call.name}(${truncate(JSON.stringify(call.args), 100)})`, call.args, {
        direction: "call", actor: "app", because: "the model's response asked for it",
      });
      const index = result.toolCalls.length;

      // TOOL STAGE, in this process: the output filter.
      const filtered = toolStage({ name: call.name, args: call.args }, index, stage);
      if (filtered) {
        const text = `Blocked by the ${filtered.layer} before it was sent: ${filtered.reason}.`;
        result.toolCalls.push({
          iteration: call.iteration, name: call.name, args: call.args, executed: false, isError: true, text,
          permission: undefined, confirmation: undefined, overlays: [],
        });
        emit({ type: "tool_end", id: call.id, name: call.name, isError: true, elapsedMs: 0 });
        return { kind: "result", content: text };
      }

      // Across the MCP boundary — the tool server, and layer 5's rules.
      const outcome = await tools.call(call.name, call.args, session("model"));
      for (const q of outcome.queries) {
        logger.data(`SQL ${truncate(q.sql, 80)} → ${q.rows} row${q.rows === 1 ? "" : "s"}, ${q.ms} ms`, q);
      }
      noteOverlays(outcome.overlays, `the ${call.name} result`);
      const verdict = outcome.permission;
      if (verdict && verdict.decision !== "not-enforced") {
        logger.defense("tool-permissions", "tool", `tool-permissions: ${verdict.decision} — ${verdict.reason}`, verdict,
          { because: `the tool server checks "${verdict.rule}"` });
      }
      logger.tool(`${call.name} → ${outcome.isError ? "error: " : ""}${truncate(outcome.text, 100)}`,
        { text: outcome.text, isError: outcome.isError, data: outcome.data }, { direction: "back", actor: "tool" });

      // Layer 5's refusals and filters are defence actions, so the scorer
      // can attribute a block to the layer that made it.
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

      // INPUT STAGE — the result is untrusted text too.
      const checked = await inputStage({ source: `tool:${call.name}#${index + 1}`, text: outcome.text }, stage);
      if (checked.block) return { kind: "stop", reason: `${checked.block.layer}: ${checked.block.reason}` };
      return { kind: "result", content: checked.chunk.text };
    };

    // One pass per turn: the opening message, then each follow-up a
    // multi-turn attack scripts as the customer's next reply.
    const followUps = request.followUps ?? [];
    for (let turn = 0; turn <= followUps.length; turn++) {
      if (turn > 0) {
        const message = followUps[turn - 1] ?? "";
        logger.info(`The customer replied (turn ${turn + 1} of ${followUps.length + 1})`, { message }, {
          actor: "attacker", because: "a multi-turn attack scripts the conversation",
        });
        const checked = await inputStage({ source: `conversation:turn-${turn + 1}`, text: message }, stage);
        if (checked.block) {
          result.loopOutcome = "stopped";
          return holdAndEscalate(checked.block);
        }
        messages.push({ role: "user", content: renderParts([trusted("The customer replied in the live chat:\n"), untrusted(`conversation:turn-${turn + 1}`, checked.chunk.text)]) });
      }

      const loop = await runToolLoop({ model: request.model, messages, tools: ollamaTools, think: request.reasoning, ...sampling }, handle, ctx);
      result.loopOutcome = loop.outcome;
      result.textToolCall = result.textToolCall || loop.textToolCall;
      messages.splice(0, messages.length, ...loop.messages);

      if (loop.outcome === "stopped") {
        const block = result.defenseActions.filter((a) => a.decision === "block").at(-1);
        return holdAndEscalate({ layer: block?.layer ?? "classifier", stage: block?.stage ?? "input", reason: loop.stopReason ?? "a defence stopped the turn" });
      }
      if (loop.outcome !== "replied") {
        logger.warn(`The tool loop ended without a reply (${loop.outcome})`);
        return finish();
      }

      // 5. The structured reply.
      const reply = await requestReply(messages, { model: request.model, think: request.reasoning, ...sampling }, ctx);
      if (!reply.ok) return fail(`The structured reply did not parse after a retry: ${reply.error}`, { raw: reply.raw });
      result.reply = reply.reply;
      result.delivered = false;
      logger.info(`Structured reply: order ${reply.reply.order_id ?? "none"} · status ${reply.reply.order_status_reported ?? "none"} · ` +
        `refund ${reply.reply.refund_amount ?? "none"} · needs_human ${reply.reply.needs_human}`, reply.reply, { actor: "model" });

      // 6. OUTPUT STAGE.
      const withheld = outputStage(reply.reply, stage);
      if (withheld) return holdAndEscalate(withheld);

      // The next turn sees the reply the customer saw, not the draft.
      messages.push({ role: "assistant", content: reply.reply.reply_text });

      // 7. Delivery — the app's call, to the ticket's own customer.
      const delivered = await tools.call("send_email",
        { to: ticket.from, subject: `Re: ${ticket.subject}`.slice(0, 200), body: reply.reply.reply_text.slice(0, 4000) }, session("app"));
      logger.tool(`app delivered the reply to ${ticket.from}`, { text: delivered.text, outbox: delivered.outbox }, {
        direction: "back", actor: "tool", because: "replies are delivered by the app, to the ticket's customer only",
      });
      result.outbox = delivered.outbox as OutboxEntry[];
      result.delivered = !delivered.isError;
      if (delivered.isError) return fail(`Could not deliver the reply: ${delivered.text}`);
    }

    const last = stats.lastResponse;
    logger.info(`Run complete · ${stats.requests} model request${stats.requests === 1 ? "" : "s"} · ` +
      `${((Date.now() - started) / 1000).toFixed(1)} s` + (last ? ` · ${tokensPerSecond(last) ?? "?"} tok/s` : ""));
    return finish();
  } catch (error: unknown) {
    return fail(error instanceof Error ? error.message : String(error), error instanceof Error ? { name: error.name, message: error.message } : error);
  }
}
