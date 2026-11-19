/**
 * loop.ts — the tool loop: ask the model, run the tools it asks for, repeat.
 *
 * In outline:
 *
 *   1. Send the conversation to the local model WITH the tool definitions.
 *   2. If it asks for tool calls, hand each one to the caller's
 *      `ToolHandler`, append what the handler says the model should read,
 *      and go back to 1.
 *   3. When it stops asking, its last text is the DRAFT. The structured
 *      reply is a separate request afterwards (reply.ts) — format and
 *      tools cannot share one.
 *
 * At most MAX_ITERATIONS model requests per turn.
 *
 * ---------------------------------------------------------------------------
 * What the loop does not know
 * ---------------------------------------------------------------------------
 *
 * It does not know where tools run, what a defence is, or who is watching.
 * Each tool call goes to a `ToolHandler` supplied by the pipeline, which
 * is where the defences at the tool stage act (the output filter, then the
 * tool server's permission layer), and where a tool's result passes
 * through the input stage (spotlighting, the classifier) before the model
 * reads it. The handler returns the text the model should see — or tells
 * the loop to stop, which is how a defence ends a turn mid-way.
 *
 * Keeping the loop ignorant of the defences is deliberate. The same loop
 * runs with no defences and with all of them; the difference between two
 * runs is in the handler and the messages, never in this file.
 *
 * ---------------------------------------------------------------------------
 * Small models fail in particular ways — make each one visible
 * ---------------------------------------------------------------------------
 *
 *   Unknown tool name        → a tool message listing the real ones; warn.
 *   Tool call written as     → detected by a HEURISTIC (a guess, labelled as
 *   text, not made             one); warn; NOT executed — quietly running it
 *                              would hide the failure. Scored as the model
 *                              failing, never as an attack succeeding.
 *   Same call twice in a row → stop before running it again; error.
 *   Iteration cap            → error; the turn is unfinished.
 *   History dropped by       → detected in model-call.ts; error.
 *   Ollama
 *
 * None of these is retried quietly. A teaching lab that hides a model's
 * failures teaches that the model does not fail.
 */

import { truncate } from "../logger.js";
import { buildRequest, type OllamaMessage, type OllamaTool, type OllamaToolCall } from "../model/ollama.js";
import { callModel, type ModelCallContext } from "./model-call.js";

/** Model requests with tools, per turn. A ticket rarely needs more than three. */
export const MAX_ITERATIONS = 6;

/** One tool call the model asked for, as the handler receives it. */
export interface RequestedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  iteration: number;
}

/** What the handler decided: what the model reads next, or stop the turn. */
export type ToolHandled =
  | { kind: "result"; content: string }
  | { kind: "stop"; reason: string };

export type ToolHandler = (call: RequestedToolCall) => Promise<ToolHandled>;

export interface ToolLoopInput {
  model: string;
  /** The conversation so far: system prompt, any earlier turns, the new user message. */
  messages: OllamaMessage[];
  tools: OllamaTool[];
  think: boolean;
  temperature?: number;
  seed?: number;
}

export interface ToolLoopResult {
  /**
   *   replied     the model stopped calling tools; `draft` is its last text
   *   unfinished  the iteration cap, or the same call twice in a row
   *   stopped     the handler stopped the turn (a defence ended it)
   */
  outcome: "replied" | "unfinished" | "stopped";
  draft: string;
  /** The full conversation, including tool calls and results, for the reply request. */
  messages: OllamaMessage[];
  /** The handler's reason, when outcome is "stopped". */
  stopReason?: string;
  /** The heuristic fired on the draft. */
  textToolCall: boolean;
}

/** JSON with sorted keys, so {a,b} and {b,a} compare equal. */
function stableKey(name: string, args: Record<string, unknown>): string {
  const sorted = Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b)));
  return `${name}(${JSON.stringify(sorted)})`;
}

/**
 * A HEURISTIC: does this reply text look like a tool call the model wrote
 * out instead of making?
 *
 * Small models sometimes print `{"name": "lookup_order", "arguments": {...}}`
 * — or wrap it in a ```json fence or <tool_call> tags — as their reply,
 * rather than producing a real tool call. Looks for an object with a
 * string `name` and an `arguments` / `parameters` object, or a `function`
 * wrapper. Not any JSON: the structured reply is JSON too, and is never
 * passed through this check.
 */
export function looksLikeTextToolCall(content: string): boolean {
  const unwrapped = content
    .replace(/<\/?tool_call>/g, "")
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  if (!unwrapped.startsWith("{") && !unwrapped.startsWith("[")) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapped);
  } catch {
    return false;
  }
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  return candidates.some((c) => {
    if (typeof c !== "object" || c === null) return false;
    const o = c as Record<string, unknown>;
    const fn = (typeof o.function === "object" && o.function !== null ? o.function : o) as Record<string, unknown>;
    return typeof fn.name === "string" &&
      (typeof fn.arguments === "object" || typeof fn.parameters === "object" || typeof fn.arguments === "string");
  });
}

export async function runToolLoop(input: ToolLoopInput, handle: ToolHandler, ctx: ModelCallContext): Promise<ToolLoopResult> {
  const { logger } = ctx;
  const messages = [...input.messages];
  const toolNames = new Set(input.tools.map((t) => t.function.name));
  let previousCallKey: string | undefined;

  for (let iteration = 1; ; iteration++) {
    if (iteration > MAX_ITERATIONS) {
      logger.error(`Stopped after ${MAX_ITERATIONS} model requests without a final reply`, undefined, {
        because: "the iteration cap stops a model that keeps calling tools",
      });
      return { outcome: "unfinished", draft: "", messages, textToolCall: false };
    }
    logger.iteration = iteration;

    const response = await callModel(
      buildRequest({
        model: input.model, messages, tools: input.tools, think: input.think,
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
      }),
      "tool loop",
      iteration === 1 ? "a ticket was opened" : "the tool results are ready",
      ctx,
    );

    const calls: OllamaToolCall[] = response.message.tool_calls ?? [];
    if (calls.length === 0) {
      const draft = response.message.content;
      const textToolCall = looksLikeTextToolCall(draft);
      if (textToolCall) {
        logger.warn("The model wrote a tool call as text instead of making one — not executed (heuristic)", { content: draft }, {
          actor: "model", because: "running it quietly would hide that the model failed to call the tool",
        });
      }
      messages.push({ role: "assistant", content: draft });
      return { outcome: "replied", draft, messages, textToolCall };
    }

    // Keep the assistant's tool-call message in the conversation: the
    // model needs to see what it asked for next to the results.
    messages.push({ role: "assistant", content: response.message.content, tool_calls: calls });
    logger.info(`The model asked for ${calls.length} tool call${calls.length === 1 ? "" : "s"}`, calls, {
      actor: "model", because: "its response contained tool_calls",
    });

    for (const call of calls) {
      const name = call.function.name;
      const args = (call.function.arguments ?? {}) as Record<string, unknown>;

      const key = stableKey(name, args);
      if (key === previousCallKey) {
        logger.error(`The model asked for the same call twice in a row: ${truncate(key, 90)} — stopping`, call, {
          actor: "model", because: "repeating an identical call will not change its result",
        });
        return { outcome: "unfinished", draft: "", messages, textToolCall: false };
      }
      previousCallKey = key;

      if (!toolNames.has(name)) {
        logger.warn(`The model asked for a tool that does not exist: ${name}`, call, {
          actor: "model", because: "small models sometimes invent tool names",
        });
        messages.push({ role: "tool", tool_name: name, content: `No such tool: ${name}. Available tools: ${[...toolNames].join(", ")}.` });
        continue;
      }

      const handled = await handle({ id: call.id ?? `${iteration}-${name}`, name, args, iteration });
      if (handled.kind === "stop") {
        return { outcome: "stopped", draft: "", messages, stopReason: handled.reason, textToolCall: false };
      }
      messages.push({ role: "tool", tool_name: name, content: handled.content });
    }
  }
}
