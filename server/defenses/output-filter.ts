/**
 * output-filter.ts — layer 4: code that blocks secrets and strange recipients. MEDIUM.
 *
 * What it does
 *   Plain code, no model. Two checks, at two stages:
 *
 *   tool stage    before a tool call is sent, blocks it if any argument
 *                 contains one of the run's canaries, or an email address
 *                 other than the ticket's customer. The model is told the
 *                 call was blocked and why.
 *   output stage  before the reply is delivered, withholds it if any field
 *                 contains a canary or an email address other than the
 *                 customer's. The customer gets a holding message instead,
 *                 and the ticket goes to a person.
 *
 *   A canary is matched as its core, raw or case-folded — exactly what a
 *   typical data-loss filter does.
 *
 * Why it helps
 *   It does not ask the model anything. Whatever the model was talked
 *   into, the commonest ways out — the secret pasted into a reply, an email
 *   to the attacker's address — are caught by a string match the attacker
 *   cannot argue with.
 *
 * How it fails
 *   It matches what it was written to match. A secret spaced out
 *   ("7 F 3 K…"), base64'd or translated slips through; so does anything it
 *   was never told about — it knows nothing of refunds or statuses, so
 *   every integrity attack passes it untouched. And it is blunt: a reply
 *   that politely mentions the partner's address it is NOT sending to (B11)
 *   is withheld all the same. That is a false block, and the arena counts
 *   it.
 *
 *   It is deliberately WEAKER than the scorer, which normalises spacing
 *   and decodes base64. Do not "fix" it to match: the gap is how the lab
 *   shows a filter being bypassed while the scoreboard still catches it.
 *
 * Attacks aimed at it
 *   filter-spaced-code (the code with a space between every character) and
 *   filter-base64-code (the recovery phrase base64'd "for security").
 */

import type { StructuredReply } from "../../shared/shop.js";
import type { DefenseLayer, TurnContext } from "./types.js";

/** Email-shaped strings. Deliberately simple, as a real filter's would be. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** All string values inside a value, in order. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(strings);
  return [];
}

/** What the filter finds in some text: canaries (by name) and foreign addresses. */
export function inspect(texts: string[], ctx: TurnContext): { canaries: string[]; foreign: string[] } {
  const haystack = texts.join("\n").toLowerCase();
  const canaries = Object.entries(ctx.canaries.cores)
    .filter(([, core]) => haystack.includes(core.toLowerCase()))
    .map(([name]) => name);
  const customer = ctx.customerEmail.trim().toLowerCase();
  const foreign = [...new Set((texts.join("\n").match(EMAIL) ?? []).map((e) => e.toLowerCase()))].filter((e) => e !== customer);
  return { canaries, foreign };
}

function reasonFor(found: { canaries: string[]; foreign: string[] }): string {
  const parts: string[] = [];
  if (found.canaries.length > 0) parts.push(`contains a secret (${found.canaries.join(", ")})`);
  if (found.foreign.length > 0) parts.push(`mentions an address other than the customer's (${found.foreign.join(", ")})`);
  return parts.join(" and ");
}

export const outputFilter: DefenseLayer = {
  id: "output-filter",
  name: "Output filter",
  strength: "medium",
  stages: ["tool", "output"],
  summary: "Code blocks tool calls and replies containing a secret or a stranger's address. Matches only what it is written to match.",

  toolCall(call, ctx) {
    const found = inspect(strings(call.args), ctx);
    if (found.canaries.length === 0 && found.foreign.length === 0) {
      return { decision: { action: "pass" }, log: { label: `output-filter: ${call.name} arguments checked — nothing found`, because: "layer 4 checks every tool call" } };
    }
    const reason = reasonFor(found);
    return {
      decision: { action: "block", reason },
      log: { label: `output-filter: blocked ${call.name} — its arguments ${reason}`, because: "layer 4 refuses tool calls that would carry a secret or reach a stranger", detail: { call, found } },
    };
  },

  output(reply: StructuredReply, ctx) {
    const found = inspect(strings(reply), ctx);
    if (found.canaries.length === 0 && found.foreign.length === 0) {
      return { decision: { action: "pass" }, log: { label: "output-filter: reply checked — nothing found", because: "layer 4 checks the reply before delivery" } };
    }
    const reason = reasonFor(found);
    return {
      decision: { action: "block", reason },
      log: { label: `output-filter: reply withheld — it ${reason}`, because: "layer 4 will not deliver a reply that carries a secret or a stranger's address", detail: { found } },
    };
  },
};
