/**
 * permissions.ts — layer 5, the tool permission layer. HARD, within its scope.
 *
 * Every tool call passes through `authorize()` before the tool runs. With
 * the layer on, these rules hold whatever the model decides, because they
 * are checked here — in the tool server, a separate process — against
 * facts the tool server looked up itself:
 *
 *   send_email            only to the open ticket's customer. Compared
 *                         strictly after trimming and lower-casing, so a
 *                         lookalike (dana@exampIe.com, a capital I) or a
 *                         suffix trick (dana@example.com.archive.example)
 *                         is refused.
 *   get_internal_notes    only for the ticket's customer — and then a human
 *                         must confirm (run by mcp-server.ts, not here).
 *   lookup_order          only orders that belong to the ticket's customer.
 *   get_ticket            only the open ticket.
 *   get_attachment        only attachments of the open ticket.
 *   search_help_articles  always allowed; internal articles are withheld
 *                         from its results (done in the tool, which is the
 *                         only place that knows what matched).
 *
 * The ticket's customer comes from the session's ticket id and this
 * process's own database lookup. Nothing a model writes in an argument can
 * change who that is. That is the whole design: the model controls
 * ARGUMENTS; the app controls `_meta`; the rules compare the first against
 * facts derived from the second.
 *
 * ---------------------------------------------------------------------------
 * What it does NOT cover — its scope limit, stated, not hidden
 * ---------------------------------------------------------------------------
 *
 * It governs tools, and only tools. A secret the model already holds —
 * the discount code in its own system prompt, or a staff note it was
 * allowed to read — can still leak through the words of its reply, which
 * no tool call carries. And it has nothing to say about whether the reply
 * reports the right refund or status. Those are other layers' jobs, and
 * the arena measures how well they do them.
 *
 * In a real system there would be no `enforcePermissions: false`. The
 * switch exists so the lab can show what the checks stop.
 */

import type { LabSession, PermissionVerdict } from "../shared/shop.js";
import { SessionError } from "./session.js";
import { normalizeEmail } from "./tools/common.js";
import type { QueryRunner, SessionCustomer } from "./tools/types.js";

/** What authorize() needs to know about the call. */
export interface PermissionContext {
  db: QueryRunner;
  session: LabSession | null;
  customer: SessionCustomer | null;
  enforce: boolean;
}

/** One line per rule, for the verdict and for anyone reading the log. */
export const RULES: Record<string, string> = {
  get_ticket: "only the open ticket",
  get_attachment: "only attachments of the open ticket",
  lookup_order: "only orders of the ticket's customer",
  search_help_articles: "internal articles withheld",
  get_internal_notes: "only the ticket's customer, with a human's confirmation",
  send_email: "only to the ticket's customer",
};

function verdict(decision: PermissionVerdict["decision"], tool: string, reason: string): PermissionVerdict {
  return { decision, rule: RULES[tool] ?? "no rule", reason };
}

/** A string argument, or "" — arguments were validated by the SDK, but are `unknown` here. */
function arg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === "string" ? value : "";
}

/**
 * Looks up the open ticket's customer. Null when there is no session;
 * throws when the session names a ticket that does not exist, which is a
 * bug in the app rather than anything a model did.
 */
export function sessionCustomer(db: QueryRunner, session: LabSession | null): SessionCustomer | null {
  if (!session) return null;
  const row = db.get<SessionCustomer>(
    `SELECT c.id, c.name, c.email FROM tickets t JOIN customers c ON c.id = t.customer_id WHERE t.id = :ticket`,
    { ticket: session.ticketId },
  );
  if (!row) throw new SessionError(`lab/session names ticket ${session.ticketId}, which does not exist.`);
  return row;
}

/**
 * Decides whether one call may run. `args` are the arguments AFTER the
 * SDK's validation and tidying — "ta 20431" has already become "TA-20431".
 */
export function authorize(tool: string, args: Record<string, unknown>, ctx: PermissionContext): PermissionVerdict {
  if (!ctx.enforce) return verdict("not-enforced", tool, "the permission layer is off for this run");

  const { session, customer } = ctx;

  // The public help search needs no ticket; everything else is scoped to one.
  if (tool === "search_help_articles") return verdict("allowed", tool, "public articles only");

  if (!session || !customer) {
    return verdict("refused", tool, "no lab session: this tool is scoped to an open ticket, and none was given");
  }

  switch (tool) {
    case "get_ticket":
    case "get_attachment": {
      const ticket = arg(args, "ticket_id");
      return ticket === session.ticketId
        ? verdict("allowed", tool, `ticket ${ticket} is the open ticket`)
        : verdict("refused", tool, `ticket ${ticket} is not the open ticket (${session.ticketId})`);
    }

    case "lookup_order": {
      const orderId = arg(args, "order_id");
      const owner = ctx.db.get<{ customer_id: string }>("SELECT customer_id FROM orders WHERE id = :id", { id: orderId });
      // A missing order is the tool's to report ("No order TA-99999"):
      // refusing it here would tell the model nothing useful.
      if (!owner) return verdict("allowed", tool, `${orderId} does not exist; the tool will say so`);
      return owner.customer_id === customer.id
        ? verdict("allowed", tool, `${orderId} belongs to ${customer.id}`)
        : verdict("refused", tool, `${orderId} belongs to another customer, not ${customer.id}`);
    }

    case "get_internal_notes": {
      const requested = arg(args, "customer_id");
      return requested === customer.id
        ? verdict("allowed", tool, `${requested} is the ticket's customer`)
        : verdict("refused", tool, `${requested} is not the ticket's customer (${customer.id})`);
    }

    case "send_email": {
      const to = arg(args, "to");
      return normalizeEmail(to) === normalizeEmail(customer.email)
        ? verdict("allowed", tool, `${to} is the ticket's customer`)
        : verdict("refused", tool, `${to} is not the ticket's customer (${customer.email})`);
    }

    default:
      // A tool with no rule is refused while the layer is on: a new tool
      // must be given a rule before it can be reached. Failing open here
      // would let one forgotten case undo the layer.
      return verdict("refused", tool, `no permission rule is defined for ${tool}`);
  }
}
