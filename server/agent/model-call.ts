/**
 * model-call.ts — sends one request to the local model, and makes it visible.
 *
 * Every model request in the lab goes through `callModel()`: the tool
 * loop's requests, the structured-reply request, the input classifier's,
 * the quarantined reader's. One function, so every request is logged the
 * same way — the full request body out, the full response back — and
 * every response is checked for the same silent failure.
 *
 * ---------------------------------------------------------------------------
 * The silent failure: Ollama dropping messages
 * ---------------------------------------------------------------------------
 *
 * When a conversation outgrows num_ctx, Ollama silently drops whole older
 * messages — keeping the system prompt and the newest message, reporting
 * no error. In this lab a dropped message could be a tool result, or the
 * ticket that carries the attack, and a run would then be scored on a
 * conversation the model never saw. The only trace is
 * `prompt_eval_count`: the model was shown fewer tokens than the messages
 * contain.
 *
 * So the response's count is compared with an estimate of the MESSAGE
 * TEXT alone (about four characters per token — rough, hence the generous
 * 60% margin). Not with the previous request's count: chat templates move
 * tool definitions around. llama3.2:3b's template writes them only into
 * the last message, and only when that is a user message, so once a tool
 * result is last, ~1,000 tokens of definitions vanish from the prompt
 * legitimately. A detector that flagged any shrinking prompt raised 58
 * false alarms on the earlier project this approach was measured on.
 * Templates move definitions; they always render the messages; a real
 * drop removes whole messages.
 *
 * ---------------------------------------------------------------------------
 * Reasoning
 * ---------------------------------------------------------------------------
 *
 * When Show reasoning is on, the response carries `message.thinking`. It
 * gets its own log row and stream event, placed before the decision it
 * led to, so a reader can watch a model talk itself into obeying an
 * injection. It is labelled honestly: reasoning is more generated text,
 * not proof of why the model acted.
 */

import type { StreamEvent } from "../../shared/types.js";
import type { Logger } from "../logger.js";
import { chat, ms, ollamaConfig, tokensPerSecond, type ChatRequest, type ChatResponse, type OllamaMessage } from "../model/ollama.js";

/** Above this share of the context window, warn. */
const CONTEXT_WARN_RATIO = 0.85;

/**
 * Below this share of the estimated message tokens, messages were dropped.
 * Generous, because the estimate is rough; a real drop removes whole
 * messages and lands far below it.
 */
const DROP_RATIO = 0.6;

/** About four characters per token — rough, and only used with DROP_RATIO's margin. */
function estimateMessageTokens(messages: OllamaMessage[]): number {
  const chars = messages.reduce(
    (sum, m) => sum + m.content.length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0),
    0,
  );
  return Math.round(chars / 4);
}

/** Running facts about one run's model requests, shared by every caller. */
export interface ModelCallStats {
  requests: number;
  droppedMessages: boolean;
  peakPromptTokens: number;
  lastResponse: ChatResponse | undefined;
}

export function newModelCallStats(): ModelCallStats {
  return { requests: 0, droppedMessages: false, peakPromptTokens: 0, lastResponse: undefined };
}

export interface ModelCallContext {
  logger: Logger;
  emit: (event: StreamEvent) => void;
  stats: ModelCallStats;
  signal?: AbortSignal;
}

/** "asked for get_ticket, lookup_order" or "replied (212 chars)". */
function describeResponse(response: ChatResponse): string {
  const calls = response.message.tool_calls ?? [];
  return calls.length > 0
    ? `asked for ${calls.map((c) => c.function.name).join(", ")}`
    : `replied (${response.message.content.length} chars)`;
}

/**
 * Sends one request, logging both halves and checking the context budget.
 * `purpose` names the request in the log ("tool loop", "structured reply",
 * "classifier"); `because` completes "this request was sent because…".
 */
export async function callModel(req: ChatRequest, purpose: string, because: string, ctx: ModelCallContext): Promise<ChatResponse> {
  const { logger, emit, stats } = ctx;
  const { numCtx } = ollamaConfig();
  stats.requests += 1;
  const n = stats.requests;

  // No arrows in the label: direction is its own field, and the log panel
  // (or attack.ts) draws the arrow from it.
  logger.model(`${req.model}: request ${n} — ${purpose}${req.format ? " (structured, no tools)" : ""}`, req, {
    direction: "out", actor: "app", because,
  });

  const response = await chat(req, ctx.signal);
  stats.lastResponse = response;

  const thinking = response.message.thinking?.trim();
  if (thinking) {
    // Ollama reports one eval time for reasoning and reply together, so the
    // seconds shown are the whole response's generation time.
    const seconds = Math.round(ms(response.eval_duration) / 100) / 10;
    logger.model(`${req.model} reasoned for ${thinking.length.toLocaleString("en-US")} characters before responding`,
      { thinking }, { actor: "model", because: "Show reasoning is on — this is more generated text, not proof of why it acted" });
    emit({ type: "reasoning", request: n, text: thinking, seconds });
  }

  const tps = tokensPerSecond(response);
  const prompt = response.prompt_eval_count ?? 0;
  stats.peakPromptTokens = Math.max(stats.peakPromptTokens, prompt);
  const load = ms(response.load_duration);
  logger.model(
    `${req.model} ${describeResponse(response)} · ${tps ?? "?"} tok/s · ${prompt}/${numCtx} tokens` +
      (load > 1000 ? ` · model load ${(load / 1000).toFixed(1)} s` : ""),
    response,
    { direction: "in", actor: "model" },
  );

  const estimate = estimateMessageTokens(req.messages);
  if (estimate > 500 && prompt < estimate * DROP_RATIO) {
    stats.droppedMessages = true;
    logger.error(
      `Ollama dropped earlier messages to fit the ${numCtx}-token context window (the model saw ${prompt} tokens; the messages alone are about ${estimate})`,
      { promptTokens: prompt, estimatedMessageTokens: estimate, numCtx },
      { because: "the conversation outgrew num_ctx — the model can no longer see part of it, possibly the ticket or a tool result" },
    );
  } else if (prompt >= numCtx * CONTEXT_WARN_RATIO) {
    logger.warn(`Context window nearly full: ${prompt} of ${numCtx} tokens`, { promptTokens: prompt, numCtx }, {
      because: "past this, Ollama silently drops older messages",
    });
  }
  return response;
}
