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
 *   5. The structured reply, the OUTPUT STAGE, and delivery by the app
 *      (run-context.ts, shared with the separated shape).
 *
 * "Direct" because the model that calls tools reads the untrusted text —
 * fenced or not — directly. That is the one thing privilege separation
 * changes (separated.ts); everything else is shared, in run-context.ts.
 *
 * The layers know nothing about this file. Each stage calls stages.ts,
 * which runs whichever layers are on, logs every decision and records
 * every block — so the same code runs the undefended assistant and the
 * fully defended one.
 */

import type { TicketResult } from "../../shared/shop.js";
import { runToolLoop, type RequestedToolCall, type ToolHandled } from "../agent/loop.js";
import { toOllamaTool } from "../agent/tool-format.js";
import type { OllamaMessage } from "../model/ollama.js";
import { CONSOLE_INSTRUCTION, baseSystemPrompt } from "./prompts.js";
import {
  APP_ONLY_TOOLS, announce, complete, createRunContext, fail, finish, holdAndEscalate, loadTicket,
  replyAndDeliver, runToolCall, stageDeps,
} from "./run-context.js";
import { inputStage, systemPromptStage } from "./stages.js";
import type { RunDeps, RunRequest, RunResult } from "./types.js";
import { renderParts, trusted, untrusted, type MessagePart } from "./untrusted.js";

export { APP_ONLY_TOOLS, HOLDING_REPLY, newRunId } from "./run-context.js";

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
  const rc = createRunContext(request, deps);
  const { logger } = deps;
  deps.tools.setConfirmer(request.confirmer);
  announce(rc, "direct pipeline");

  try {
    // 1. Load the ticket.
    const ticket = await loadTicket(rc);
    if (!ticket) return rc.result;
    const stage = stageDeps(rc, ticket);

    // 2. MODEL STAGE — the system prompt.
    const systemPrompt = systemPromptStage(baseSystemPrompt(rc.canaries.values.discountCode), stage);

    // 3. INPUT STAGE — the first message's untrusted parts.
    const parts = ticketMessageParts(ticket, request.chatMessage);
    for (const part of parts) {
      if (part.trust !== "untrusted") continue;
      const checked = await inputStage({ source: part.source ?? "untrusted", text: part.text }, stage);
      if (checked.block) {
        rc.result.loopOutcome = "stopped";
        return holdAndEscalate(rc, ticket, checked.block);
      }
      part.text = checked.chunk.text;
    }
    const messages: OllamaMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: renderParts(parts) },
    ];

    // 4. The tool loop: tool stage before each call, input stage on each result.
    const ollamaTools = (await deps.tools.tools()).filter((t) => !APP_ONLY_TOOLS.has(t.name)).map(toOllamaTool);
    const handle = async (call: RequestedToolCall): Promise<ToolHandled> => {
      const done = await runToolCall(rc, call, stage);
      if (done.kind === "blocked") return { kind: "result", content: done.text };
      const checked = await inputStage({ source: `tool:${call.name}#${done.index + 1}`, text: done.outcome.text }, stage);
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
          rc.result.loopOutcome = "stopped";
          return holdAndEscalate(rc, ticket, checked.block);
        }
        messages.push({ role: "user", content: renderParts([trusted("The customer replied in the live chat:\n"), untrusted(`conversation:turn-${turn + 1}`, checked.chunk.text)]) });
      }

      const loop = await runToolLoop({ model: request.model, messages, tools: ollamaTools, think: request.reasoning, ...rc.sampling }, handle, rc.model);
      rc.result.loopOutcome = loop.outcome;
      rc.result.textToolCall = rc.result.textToolCall || loop.textToolCall;
      messages.splice(0, messages.length, ...loop.messages);

      if (loop.outcome === "stopped") {
        const block = rc.result.defenseActions.filter((a) => a.decision === "block").at(-1);
        return holdAndEscalate(rc, ticket, { layer: block?.layer ?? "classifier", stage: block?.stage ?? "input", reason: loop.stopReason ?? "a defence stopped the turn" });
      }
      if (loop.outcome !== "replied") {
        logger.warn(`The tool loop ended without a reply (${loop.outcome})`);
        return finish(rc);
      }

      // 5. Reply, output stage, delivery.
      const delivered = await replyAndDeliver(rc, ticket, messages, stage);
      if (delivered !== "delivered") return delivered;
    }
    return complete(rc);
  } catch (error: unknown) {
    return fail(rc, error instanceof Error ? error.message : String(error), error instanceof Error ? { name: error.name, message: error.message } : error);
  }
}
