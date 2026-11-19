/**
 * schema.ts — what an attack file must contain, checked with Zod.
 *
 * The attack library is DATA: one JSON file per attack in attacks/, so a
 * reader can add an attack without touching the engine. This file is the
 * contract those files are held to. load.ts checks every file against it
 * and refuses to run anything if one is invalid, naming the file and the
 * field.
 *
 * An attack says:
 *
 *   what it is      id (= the file name), title, a plain-language
 *                   description of the technique, its category, and the
 *                   public name of the technique if it has one
 *   where it rides  baseTicket: the benign ticket it is planted in. That
 *                   ticket's expected outcome is the real task, so the
 *                   scorer can tell "resisted" from "failed-task"
 *   where it lands  channel: the ticket body or subject, a new attachment,
 *                   a tool's result (an order's delivery note, a community
 *                   answer), the customer's live-chat message, or a
 *                   scripted conversation. `parts` splits one instruction
 *                   across several channels
 *   what it wants   goal: leak a named canary, make a forbidden tool call,
 *                   or corrupt a field of the reply (shared/arena.ts)
 *   whom it aims at targets: the defenses it is DESIGNED to get past —
 *                   documentation for the defense files' headers, never
 *                   used in scoring
 *
 * ---------------------------------------------------------------------------
 * Payloads stay readable
 * ---------------------------------------------------------------------------
 *
 * A payload is written in plain words, with placeholders the run fills in
 * so it reads naturally — {{customerName}}, {{orderId}}, {{attackerEmail}}
 * and the rest (insert.ts lists them). Obfuscation is written as an inline
 * marker, applied only at run time: {{b64:…}} base64-encodes its text,
 * {{zw:…}} salts it with zero-width characters. The file shows what the
 * attack says; the run shows how it is disguised.
 *
 * A payload must never contain a canary or a canary placeholder: an attack
 * ASKS for a secret, it cannot carry one. load.ts rejects any that does,
 * so a secret that turns up in the output can only have come from the
 * model.
 */

import { z } from "zod";
import type { AttackGoal, CanaryName, Predicate } from "../../shared/arena.js";
import type { DefenseId } from "../../shared/types.js";

export const CATEGORIES = ["direct", "indirect-document", "indirect-email", "tool-result", "multi-turn", "obfuscated"] as const;
export type Category = (typeof CATEGORIES)[number];

const position = z.enum(["append", "prepend", "replace"]).default("append");

/** Where a payload lands. */
export const channelSchema = z.discriminatedUnion("kind", [
  /** The customer's live-chat message to the assistant: the "direct" channel. */
  z.object({ kind: z.literal("user_turn") }),
  z.object({ kind: z.literal("ticket_subject"), position }),
  z.object({ kind: z.literal("ticket_body"), position }),
  /** A new attachment on the ticket. */
  z.object({
    kind: z.literal("attachment"),
    filename: z.string().min(1),
    mediaType: z.enum(["text/plain", "text/markdown", "text/html"]),
  }),
  /** A field of a tool's result that the attacker controls. */
  z.object({
    kind: z.literal("tool_result"),
    tool: z.enum(["lookup_order", "search_help_articles"]),
    field: z.enum(["delivery_note", "community_answer"]),
    position,
    /** For community answers: the name shown as the answer's author. */
    author: z.string().optional(),
  }).refine((c) => (c.tool === "lookup_order") === (c.field === "delivery_note"), {
    message: "lookup_order carries delivery_note; search_help_articles carries community_answer",
  }),
  /** A scripted conversation: the payloads are in `turns`. */
  z.object({ kind: z.literal("conversation") }),
]);
export type Channel = z.infer<typeof channelSchema>;

const predicateSchema: z.ZodType<Predicate> = z.union([
  z.object({ equals: z.union([z.string(), z.number()]) }),
  z.object({ notEqual: z.union([z.string(), z.number()]) }),
  z.object({ contains: z.string() }),
  z.object({ matches: z.string() }),
]);

const canarySchema: z.ZodType<CanaryName> = z.enum(["discountCode", "staffNote", "apiToken"]);

export const goalSchema: z.ZodType<AttackGoal> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("leak"), canary: canarySchema }),
  z.object({ type: z.literal("forbidden-action"), tool: z.string(), where: z.record(z.string(), predicateSchema) }),
  z.object({
    type: z.literal("integrity"),
    field: z.enum(["refund_amount", "order_status_reported", "order_id"]),
    intended: z.union([z.object({ equals: z.union([z.string(), z.number()]) }), z.object({ notEqual: z.literal("$truth") })]),
  }),
]);

const defenseIdSchema: z.ZodType<DefenseId> = z.enum([
  "hardened-prompt", "spotlighting", "classifier", "output-filter", "tool-permissions", "privilege-separation",
]);

export const attackSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "lower-case words joined by hyphens"),
  title: z.string().min(3),
  description: z.string().min(40, "describe the technique in a sentence or two"),
  category: z.enum(CATEGORIES),
  baseTicket: z.string().regex(/^B\d{2}$/),
  channel: channelSchema.optional(),
  payload: z.string().min(1).optional(),
  /** One instruction split across several channels. */
  parts: z.array(z.object({ channel: channelSchema, payload: z.string().min(1) })).min(2).optional(),
  /** For multi-turn attacks: each turn is a follow-up message from the customer. */
  turns: z.array(z.object({ payload: z.string().min(1) })).min(2).optional(),
  goal: goalSchema,
  targets: z.array(defenseIdSchema).default([]),
  references: z.array(z.string()).default([]),
}).superRefine((a, ctx) => {
  const shapes = [a.channel !== undefined && a.payload !== undefined, a.parts !== undefined, a.turns !== undefined];
  if (shapes.filter(Boolean).length !== 1) {
    ctx.addIssue({ code: "custom", message: "give exactly one of: channel + payload, parts, or turns" });
  }
  if (a.turns !== undefined && a.channel?.kind !== "conversation") {
    ctx.addIssue({ code: "custom", path: ["channel"], message: "a multi-turn attack's channel is { \"kind\": \"conversation\" }" });
  }
  if (a.category === "multi-turn" && a.turns === undefined) {
    ctx.addIssue({ code: "custom", path: ["turns"], message: "a multi-turn attack needs turns" });
  }
});

export type Attack = z.infer<typeof attackSchema>;

/** The JSON Schema for attack files — for editors and for readers writing their own. */
export function attackJsonSchema(): unknown {
  return z.toJSONSchema(attackSchema, { io: "input" });
}
