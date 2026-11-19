/**
 * registry.ts — the complete list of tools the tool server offers.
 *
 * Six tools, and that list IS the fence. Whatever the assistant is told or
 * tricked into wanting, these six calls are the only things it can ask
 * the shop for. Adding a tool here widens what a model can reach; nothing
 * else in the project does.
 *
 *   get_ticket            read the support ticket (sender, subject, body, attachments)
 *   get_attachment        read one attachment's text
 *   lookup_order          one order: lines, status, totals, delivery note
 *   search_help_articles  the shop's help content, with community answers
 *   get_internal_notes    staff-only notes — needs confirmation when layer 5 is on
 *   send_email            the simulated outbox — never sends anything
 *
 * Two of them are the ones attacks aim at. get_internal_notes holds a
 * secret (the staff-note canary); send_email is the way out (to an
 * attacker's address). The others are where attack text arrives: the
 * ticket, the attachment, the delivery note, the community answers.
 *
 * There is deliberately no "list everything" tool — no tool that returns
 * every customer, every order or every note. Each tool takes one id or
 * one query and returns a bounded result, so even a fully compromised
 * model can only ask for things one at a time, in calls the log shows.
 */

import { getTicket } from "./definitions/get-ticket.js";
import { getAttachment } from "./definitions/get-attachment.js";
import { lookupOrder } from "./definitions/lookup-order.js";
import { searchHelpArticles } from "./definitions/search-help-articles.js";
import { getInternalNotes } from "./definitions/get-internal-notes.js";
import { sendEmail } from "./definitions/send-email.js";
import type { AnyTool } from "./types.js";

export type { AnyTool, QueryRunner, ToolContext, ToolOutput } from "./types.js";
export { ToolError } from "./types.js";

/** In the order a typical ticket uses them. */
export const TOOLS: AnyTool[] = [
  getTicket,
  getAttachment,
  lookupOrder,
  searchHelpArticles,
  getInternalNotes,
  sendEmail,
];

/**
 * Fails at startup if two tools share a name.
 *
 * The SDK would register both, and clients would only ever reach one — a
 * tool that silently never runs is much harder to notice than a crash.
 */
export function assertUniqueToolNames(): void {
  const seen = new Set<string>();
  for (const tool of TOOLS) {
    if (seen.has(tool.name)) {
      throw new Error(`Two tools are registered as "${tool.name}". Tool names must be unique.`);
    }
    seen.add(tool.name);
  }
}
