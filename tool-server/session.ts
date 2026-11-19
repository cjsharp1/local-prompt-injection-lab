/**
 * session.ts — reads the run's LabSession from a tool call's `_meta`.
 *
 * Every tool call from the app carries `_meta["lab/session"]`: the run id,
 * the open ticket, whether the permission layer is on, the run's canary
 * values and its attack overlays (the shape is in shared/shop.ts). This
 * file finds it, checks it against a Zod schema, and hands it to the
 * server as a typed object — or says precisely what was wrong.
 *
 * ---------------------------------------------------------------------------
 * Why `_meta` and not tool arguments
 * ---------------------------------------------------------------------------
 *
 * The model writes tool ARGUMENTS. It has no way to write `_meta`: only the
 * MCP client — the app's code — sets that. So anything the permission
 * layer relies on (which ticket is open, and so which customer may be
 * emailed) travels here, and a model persuaded by an attack to send
 * `{ to: "records@…" }` cannot also persuade the tool server that the
 * ticket's customer is someone else. Confirmed live in step 0: the record
 * arrives intact over stdio and HTTP. See docs/verified-facts.md.
 *
 * ---------------------------------------------------------------------------
 * No session means the strictest behavior, not the loosest
 * ---------------------------------------------------------------------------
 *
 * A client that sends no session — MCP Inspector, say — gets permission
 * enforcement ON with no open ticket. Ticket-scoped tools are refused,
 * because there is no customer to scope them to; the public help search
 * still works. Failing open would make "the permission layer" mean "the
 * permission layer, if the caller asks for it".
 *
 * A session that is PRESENT but malformed is a bug in the app, not
 * something the model did, and is reported as one.
 */

import { z } from "zod";
import type { LabSession } from "../shared/shop.js";

/** The `_meta` key the session travels under. */
export const SESSION_META_KEY = "lab/session";

const position = z.enum(["append", "prepend", "replace"]);
const mediaType = z.enum(["text/plain", "text/markdown", "text/html"]);

const overlaySchema = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), kind: z.literal("ticket"), field: z.enum(["subject", "body"]), position, text: z.string() }),
  z.object({ id: z.string(), kind: z.literal("new-attachment"), attachmentId: z.string().regex(/^A-\d{4}$/), filename: z.string(), mediaType, text: z.string() }),
  z.object({ id: z.string(), kind: z.literal("attachment"), attachmentId: z.string(), position, text: z.string() }),
  z.object({ id: z.string(), kind: z.literal("order-note"), orderId: z.string().optional(), position, text: z.string() }),
  z.object({ id: z.string(), kind: z.literal("community-answer"), articleId: z.string().optional(), author: z.string(), text: z.string() }),
]);

const sessionSchema: z.ZodType<LabSession> = z.object({
  runId: z.string().min(1),
  ticketId: z.string().regex(/^T-\d{4}$/),
  enforcePermissions: z.boolean(),
  canaries: z.object({
    discountCode: z.string().optional(),
    staffNote: z.string().optional(),
    apiToken: z.string().optional(),
  }),
  overlays: z.array(overlaySchema),
  caller: z.enum(["model", "app"]),
});

/**
 * The session is wrong in a way only the app could have caused — it names
 * a ticket that does not exist, say. A class of its own so the server can
 * report it as a bug in the app, not in the tool server or the call.
 */
export class SessionError extends Error {
  override name = "SessionError";
}

/** What reading the session produced. */
export type SessionRead =
  | { ok: true; session: LabSession | null }
  | { ok: false; error: string };

/** Finds and validates the session in a request's `_meta`. */
export function readSession(meta: Record<string, unknown> | undefined): SessionRead {
  const raw = meta?.[SESSION_META_KEY];
  if (raw === undefined) return { ok: true, session: null };

  const parsed = sessionSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `malformed ${SESSION_META_KEY}: ${issue ? `${issue.path.join(".")} — ${issue.message}` : "invalid"}` };
  }
  return { ok: true, session: parsed.data };
}
