/**
 * types.ts — what a defence layer is: one small interface, four hooks.
 *
 * Every layer in this folder is a `DefenseLayer`. It names itself, says
 * how strong it is (soft, medium, hard), lists the pipeline stages it
 * works at, and implements a hook for each:
 *
 *   input         untrusted text arriving — the ticket, the live-chat
 *                 message, each tool result — before the model reads it
 *   systemPrompt  the system prompt, before the first request
 *   toolCall      a tool call the model asked for, before it is sent
 *   output        the structured reply, before it is delivered
 *
 * Every hook returns the same thing: a DECISION and a LOG ENTRY. The
 * decision is pass, transform (here is the changed value), flag (an alarm
 * that stops nothing) or block (stop it, and why). The log entry is the
 * row the activity log shows — the layer never writes to the log itself,
 * so no layer can act without saying so: the pipeline (stages.ts) logs
 * every result, including "pass".
 *
 * Two layers have no hooks here, on purpose. Tool permissions (layer 5)
 * decide in the TOOL SERVER, a separate process; the app-side file only
 * switches enforcement on and describes the layer. Privilege separation
 * (layer 6) is not a filter at a stage but a different SHAPE of pipeline,
 * chosen in pipeline/run.ts.
 *
 * Imports nothing at runtime: types only, at the bottom of the graph.
 */

import type { StructuredReply } from "../../shared/shop.js";
import type { DefenseId, Stage, Strength, StreamEvent } from "../../shared/types.js";
import type { ModelCallStats } from "../agent/model-call.js";
import type { RunCanaries } from "../canaries.js";
import type { Logger } from "../logger.js";

/** What a layer decided about one thing it inspected. */
export type Decision<T> =
  | { action: "pass" }
  | { action: "transform"; value: T; note: string }
  | { action: "flag"; reason: string }
  | { action: "block"; reason: string };

/** A decision and the log row that explains it. */
export interface LayerResult<T> {
  decision: Decision<T>;
  log: { label: string; because: string; detail?: unknown };
}

/** One piece of untrusted text, with where it came from (see pipeline/untrusted.ts). */
export interface UntrustedChunk {
  /** e.g. "ticket", "user_turn", "tool:lookup_order#2". */
  source: string;
  text: string;
}

/** A tool call the model asked for, before anything is sent. */
export interface ProposedToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** What a layer may know about the run it is defending. */
export interface TurnContext {
  runId: string;
  model: string;
  canaries: RunCanaries;
  customerEmail: string;
  /** Spotlighting's per-run delimiter token — random, never shown to the attacker. */
  spotlightToken: string;
  /** For layers that make their own model calls (the classifier). */
  logger: Logger;
  emit: (event: StreamEvent) => void;
  stats: ModelCallStats;
  signal?: AbortSignal;
  seed?: number;
  temperature?: number;
}

export interface DefenseLayer {
  id: DefenseId;
  name: string;
  strength: Strength;
  stages: Stage[];
  /** One honest sentence for the defence panel. */
  summary: string;
  input?(chunk: UntrustedChunk, ctx: TurnContext): Promise<LayerResult<UntrustedChunk>>;
  systemPrompt?(base: string, ctx: TurnContext): LayerResult<string>;
  toolCall?(call: ProposedToolCall, ctx: TurnContext): LayerResult<ProposedToolCall>;
  output?(reply: StructuredReply, ctx: TurnContext): LayerResult<StructuredReply>;
}
