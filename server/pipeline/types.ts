/**
 * types.ts — what a run is asked to do, and what it reports back.
 *
 * A RUN is one ticket handled once: the ticket loaded, the tool loop, the
 * structured reply, the reply delivered. The UI starts one per click, the
 * attack script one per command, the arena hundreds overnight — all
 * through `runTicket()` in run.ts, with these shapes.
 *
 * The `RunResult` is deliberately complete: every tool call with its
 * arguments, whether it was executed, the permission verdict, which attack
 * overlays landed, the final outbox, the canaries. The scorer (build step
 * 6) decides the outcome from this record alone — it never looks at the
 * live run — so a stored result can be re-scored later and reach the same
 * verdict.
 *
 * Imports nothing at runtime: types only.
 */

import type { Canaries, LabSession, OutboxEntry, Overlay, PermissionVerdict, StructuredReply } from "../../shared/shop.js";
import type { DefenseAction } from "../../shared/arena.js";
import type { DefenseSettings, StreamEvent } from "../../shared/types.js";
import type { Logger } from "../logger.js";
import type { Confirmer, ToolCallOutcome } from "../mcp/client.js";
import type { McpToolDefinition } from "../agent/tool-format.js";

/** What a run is asked to do. */
export interface RunRequest {
  ticketId: string;
  model: string;
  defenses: DefenseSettings;
  /** Let the model reason before each response. The caller has checked the model supports it. */
  reasoning: boolean;
  /** The attack's text, as overlays the tool server applies. Empty for a benign run. */
  overlays: Overlay[];
  /** Fixed seed for reproducible runs (the arena); default temperature. */
  seed?: number;
  temperature?: number;
  /** Who answers the tool server's confirmation requests. Default: decline. */
  confirmer?: Confirmer;
  /** Supplied by the arena so a run's id is predictable; otherwise generated. */
  runId?: string;
}

/** Where tools come from. The MCP client satisfies this. */
export interface ToolSource {
  tools(): Promise<McpToolDefinition[]>;
  call(name: string, args: Record<string, unknown>, session: LabSession): Promise<ToolCallOutcome>;
  setConfirmer(confirmer: Confirmer | undefined): void;
}

export interface RunDeps {
  logger: Logger;
  emit: (event: StreamEvent) => void;
  tools: ToolSource;
  signal?: AbortSignal;
}

/** One tool call the model asked for, and what became of it. */
export interface ToolCallRecord {
  iteration: number;
  name: string;
  args: Record<string, unknown>;
  /** The tool server ran it and it succeeded. False for refusals, declines and errors. */
  executed: boolean;
  isError: boolean;
  /** What the model read back. */
  text: string;
  permission: PermissionVerdict | undefined;
  confirmation: "confirmed" | "declined" | undefined;
  /** Attack overlays that landed in this result. */
  overlays: string[];
}

/** Everything a run produced. */
export interface RunResult {
  runId: string;
  ticketId: string;
  model: string;
  defenses: DefenseSettings;
  reasoning: boolean;
  seed: number | undefined;
  canaries: Required<Canaries>;
  canaryCores: Record<keyof Canaries, string>;
  /** The ticket customer's address, as the tool server reported it. */
  customerEmail: string;
  /** The structured reply, or null if the run did not get that far. */
  reply: StructuredReply | null;
  /** The app delivered the reply to the customer. False if it was withheld, or the run ended first. */
  delivered: boolean;
  /** The tool calls the MODEL asked for, in order. (The app's own calls are not here.) */
  toolCalls: ToolCallRecord[];
  /** What the defence layers did, in order — the scorer attributes blocks from this. */
  defenseActions: DefenseAction[];
  /** Every attack overlay that landed anywhere in the run. */
  overlaysLanded: string[];
  /** The run's outbox at the end, including the app's delivery of the reply. */
  outbox: OutboxEntry[];
  /** How the tool loop ended. */
  loopOutcome: "replied" | "unfinished" | "stopped" | "not-started";
  /** Set when the run failed: the provider, the tool server, a reply that would not parse. */
  error: string | undefined;
  requests: number;
  elapsedMs: number;
  peakPromptTokens: number;
  droppedMessages: boolean;
  textToolCall: boolean;
}
