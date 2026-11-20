/**
 * stages.ts — runs the enabled defense layers at each stage, and records what they did.
 *
 * The pipeline calls one function per stage. Each one runs every ENABLED
 * layer that has a hook for that stage, in registry order, and:
 *
 *   - logs every result as a `defense` row, naming the layer and the
 *     stage — including "pass", because "the classifier looked and saw
 *     nothing" is information
 *   - applies transforms in order (spotlighting's fence, the hardened
 *     prompt's rules)
 *   - records each block and flag as a DefenseAction in the run result,
 *     which is what the scorer attributes outcomes from
 *   - lets the first BLOCK win, and keeps running the later layers in
 *     "report only" mode, logged as such, so the log shows when more than
 *     one layer would have caught something — without crediting a layer
 *     with a block it did not make
 *
 * Layers never log or record by themselves. Routing every decision
 * through here is what makes "every defense decision is visible" true by
 * construction rather than by each layer remembering to say so.
 */

import type { DefenseAction } from "../../shared/arena.js";
import type { StructuredReply } from "../../shared/shop.js";
import type { DefenseId, DefenseSettings, Stage } from "../../shared/types.js";
import { INPUT_ORDER, MODEL_ORDER, OUTPUT_ORDER, TOOL_ORDER } from "../defenses/registry.js";
import type { DefenseLayer, LayerResult, ProposedToolCall, TurnContext, UntrustedChunk } from "../defenses/types.js";

/** The first block at a stage, if any. */
export interface StageBlock {
  layer: DefenseId;
  stage: Stage;
  reason: string;
}

export interface StageDeps {
  settings: DefenseSettings;
  ctx: TurnContext;
  /** Where block and flag actions are recorded (the run result's list). */
  actions: DefenseAction[];
}

/** Logs one layer's result, and records it if it blocked or flagged. */
function note<T>(layer: DefenseLayer, stage: Stage, result: LayerResult<T>, deps: StageDeps, reportOnly: string | undefined, toolCallIndex?: number): void {
  const label = reportOnly ? `${result.log.label} (report only — already blocked by ${reportOnly})` : result.log.label;
  deps.ctx.logger.defense(layer.id, stage, label, result.log.detail, { because: result.log.because });
  if (reportOnly) return;
  const d = result.decision;
  if (d.action === "block" || d.action === "flag") {
    deps.actions.push({ layer: layer.id, stage, decision: d.action, what: d.reason, ...(toolCallIndex !== undefined ? { toolCallIndex } : {}) });
  }
}

const enabled = (layers: DefenseLayer[], settings: DefenseSettings) => layers.filter((l) => settings[l.id]);

/** The system prompt, through every enabled layer's systemPrompt hook. */
export function systemPromptStage(base: string, deps: StageDeps): string {
  let prompt = base;
  for (const layer of enabled(MODEL_ORDER, deps.settings)) {
    if (!layer.systemPrompt) continue;
    const result = layer.systemPrompt(prompt, deps.ctx);
    note(layer, "model", result, deps, undefined);
    if (result.decision.action === "transform") prompt = result.decision.value;
  }
  return prompt;
}

/** One untrusted chunk, through the input stage: transformed text, or a block. */
export async function inputStage(chunk: UntrustedChunk, deps: StageDeps): Promise<{ chunk: UntrustedChunk; block: StageBlock | undefined }> {
  let current = chunk;
  let block: StageBlock | undefined;
  for (const layer of enabled(INPUT_ORDER, deps.settings)) {
    if (!layer.input) continue;
    const result = await layer.input(current, deps.ctx);
    note(layer, "input", result, deps, block?.layer);
    if (block) continue;
    if (result.decision.action === "transform") current = result.decision.value;
    if (result.decision.action === "block") block = { layer: layer.id, stage: "input", reason: result.decision.reason };
  }
  return { chunk: current, block };
}

/** A proposed tool call, through the app-side tool stage. */
export function toolStage(call: ProposedToolCall, toolCallIndex: number, deps: StageDeps): StageBlock | undefined {
  let block: StageBlock | undefined;
  for (const layer of enabled(TOOL_ORDER, deps.settings)) {
    if (!layer.toolCall) continue;
    const result = layer.toolCall(call, deps.ctx);
    note(layer, "tool", result, deps, block?.layer, toolCallIndex);
    if (!block && result.decision.action === "block") block = { layer: layer.id, stage: "tool", reason: result.decision.reason };
  }
  return block;
}

/** The structured reply, through the output stage, before delivery. */
export function outputStage(reply: StructuredReply, deps: StageDeps): StageBlock | undefined {
  let block: StageBlock | undefined;
  for (const layer of enabled(OUTPUT_ORDER, deps.settings)) {
    if (!layer.output) continue;
    const result = layer.output(reply, deps.ctx);
    note(layer, "output", result, deps, block?.layer);
    if (!block && result.decision.action === "block") block = { layer: layer.id, stage: "output", reason: result.decision.reason };
  }
  return block;
}
