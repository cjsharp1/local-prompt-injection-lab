/**
 * types.ts — the server's shapes, as the browser sees them.
 *
 * Re-exports the types from shared/ that the browser half uses, plus the
 * shapes of the JSON the /api routes return. Types only: every import
 * here is `import type`, so nothing from shared/ is ever loaded at run
 * time — the browser half compiles to files that need only each other.
 *
 * The client tsconfig keeps `"types": []`, so Node's globals are not
 * available here, and nothing in server/ or tool-server/ can be imported:
 * everything the browser knows arrives over the wire as JSON.
 */

import type { AttackGoal, ExpectedReply } from "../shared/arena.js";
import type { DefenseId, Stage, Strength } from "../shared/types.js";
import type { Overlay, TicketResult } from "../shared/shop.js";

export type { LogEvent, StreamEvent, DefenseId, DefenseSettings, Stage, Strength } from "../shared/types.js";
export type { RunRecord, AttackOutcome, BenignOutcome, DefenseAction } from "../shared/arena.js";
export type { StructuredReply, TicketResult, Overlay } from "../shared/shop.js";

/** GET /api/meta */
export interface MetaResponse {
  models: Array<{ name: string; parameterSize: string; supportsThinking: boolean }>;
  defaultModel: string;
  layers: Array<{ id: DefenseId; name: string; strength: Strength; stages: Stage[]; summary: string }>;
  stacks: Record<string, DefenseId[]>;
  numCtx: number;
}

/** An attack file, as the library serves it. */
export interface AttackInfo {
  id: string;
  title: string;
  description: string;
  category: string;
  baseTicket: string;
  channel?: { kind: string; [key: string]: unknown };
  payload?: string;
  parts?: Array<{ channel: { kind: string; [key: string]: unknown }; payload: string }>;
  turns?: Array<{ payload: string }>;
  goal: AttackGoal;
  targets: DefenseId[];
  references: string[];
}

/** A benign ticket's expectation. */
export interface BenignInfo {
  id: string;
  slug: string;
  title: string;
  ticket: string;
  awkward: boolean;
  why: string;
  expect: ExpectedReply;
  alternatives?: ExpectedReply[];
}

/** GET /api/library */
export interface LibraryResponse {
  attacks: AttackInfo[];
  benign: BenignInfo[];
}

/** POST /api/preview */
export interface PreviewResponse {
  base: BenignInfo;
  attack: AttackInfo | null;
  ticket: TicketResult | null;
  overlays: Overlay[];
  chatMessage: string | null;
  followUps: string[];
}
