/**
 * record.ts — turns one run and its score into the record everyone reads.
 *
 * The arena writes these to docs/arena-results.json; the UI receives the
 * same shape at the end of every run it starts. One builder for both, so
 * the workspace's outcome badge and the arena's tables can never describe
 * the same run differently.
 *
 * The record keeps what is needed to re-score and to explain a run — the
 * canaries, every tool call with its fate, every defense action, the
 * reply, the outbox — and drops what is only noise at this level (the full
 * text each tool returned is in the live log, not in the results file).
 */

import type { RunRecord } from "../../shared/arena.js";
import type { BenignTicket } from "../attacks/load.js";
import type { Attack } from "../attacks/schema.js";
import type { RunResult } from "../pipeline/types.js";
import type { AttackScore, BenignScore } from "../scoring/outcome.js";

export interface RecordMeta {
  key: string;
  stack: string;
  digest: string;
  seed: number;
  setupHash: string;
  attempt: number;
  startedAt: string;
}

export function toRecord(
  item: { kind: "attack" | "benign"; id: string; attack?: Attack; base: BenignTicket },
  r: RunResult,
  scored: AttackScore | BenignScore,
  meta: RecordMeta,
): RunRecord {
  return {
    key: meta.key, itemKind: item.kind, itemId: item.id,
    ...(item.attack ? { category: item.attack.category, goalType: item.attack.goal.type } : {}),
    baseTicket: item.base.id, stack: meta.stack, model: r.model, modelDigest: meta.digest, seed: meta.seed,
    setupHash: meta.setupHash, attempt: meta.attempt, startedAt: meta.startedAt,
    outcome: scored.outcome,
    ...("evidence" in scored ? { evidence: scored.evidence } : {}),
    taskDone: "taskDone" in scored ? scored.taskDone : scored.outcome.kind === "completed",
    taskWhy: scored.taskWhy,
    notes: scored.notes,
    canaries: r.canaries,
    toolCalls: r.toolCalls.map((c) => ({
      name: c.name, args: c.args, executed: c.executed, overlays: c.overlays,
      ...(c.permission ? { permission: c.permission.decision } : {}),
      ...(c.confirmation ? { confirmation: c.confirmation } : {}),
    })),
    defenseActions: r.defenseActions,
    overlaysLanded: r.overlaysLanded,
    reply: r.reply,
    delivered: r.delivered,
    outbox: r.outbox.map((m) => ({ to: m.to, via: m.via, subject: m.subject })),
    loopOutcome: r.loopOutcome,
    ...(r.error ? { error: r.error } : {}),
    requests: r.requests, elapsedMs: r.elapsedMs, peakPromptTokens: r.peakPromptTokens,
    droppedMessages: r.droppedMessages, textToolCall: r.textToolCall,
  };
}
