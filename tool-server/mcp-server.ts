/**
 * mcp-server.ts — builds the shop's MCP tool server.
 *
 * Exports `createServer()`, a FACTORY that returns a new `McpServer` with
 * the six tools registered. Both entry points hand this function to the
 * SDK — stdio.ts to `serveStdio`, http.ts to `createMcpHandler`.
 *
 * ---------------------------------------------------------------------------
 * Why a factory, not a server
 * ---------------------------------------------------------------------------
 *
 * The SDK's serving functions call the factory more than once: for a
 * discovery probe whose result is thrown away, and over HTTP once per
 * request. Passing one shared instance compiles, serves the first client,
 * and then breaks during version negotiation. Each call here builds a
 * fresh server. What must outlive a single server — the database
 * connection, the outbox, the confirmation key — lives at module level.
 *
 * ---------------------------------------------------------------------------
 * What happens to every tool call, in order
 * ---------------------------------------------------------------------------
 *
 *   1. Read the LabSession from `_meta` (session.ts). Malformed → a bug
 *      in the app, reported as one.
 *   2. Look up the open ticket's customer — in THIS process, from the
 *      session's ticket id. Never from a model's argument.
 *   3. Layer 5: `authorize()` (permissions.ts). Refused → the tool never
 *      runs; the model reads a refusal saying which rule stopped it.
 *   4. Layer 5, part two: a tool marked `needsConfirmation` asks a human,
 *      through MCP's input-required round trip, bound to this exact call.
 *   5. Run the tool, with overlays and canaries applied.
 *   6. Return the text (for the model), the structured result (for the
 *      UI and scorer), and `_meta`: the SQL, the overlays that landed, the
 *      permission verdict and the run's outbox.
 *
 * ---------------------------------------------------------------------------
 * The confirmation, and the trap it avoids
 * ---------------------------------------------------------------------------
 *
 * A tool asks for confirmation by returning `inputRequired(...)`; the
 * client fulfils it through its elicitation handler and retries the call
 * with the answer attached. The pattern in the SDK's own documentation
 * reads the answer from `inputResponses` FIRST — and step 0 found that a
 * client can attach an "accepted" answer to the very first call, unasked,
 * and that pattern accepts it. The tool runs with no human involved.
 *
 * So every confirmation request here carries a `requestState` sealed with
 * the SDK's HMAC helper, naming this tool, this run and a hash of these
 * arguments. The SDK verifies the seal before the handler runs (a tampered
 * one is rejected at the seam), and the handler accepts an answer only
 * when the verified state names this exact call. An unasked answer is
 * ignored and the human is asked anyway; a confirmation for customer C-007
 * cannot be replayed onto a call for C-008. Details and the live test:
 * docs/verified-facts.md.
 */

import { createHash, randomBytes } from "node:crypto";
import { McpServer, acceptedContent, createRequestStateCodec, inputRequired } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { LabSession, PermissionVerdict } from "../shared/shop.js";
import { createRecorder } from "./db.js";
import { NO_SESSION_RUN, addToOutbox, outboxFor } from "./outbox.js";
import { createOverlayApplier, fillCanaries } from "./overlays.js";
import { authorize, sessionCustomer } from "./permissions.js";
import { SessionError, readSession } from "./session.js";
import { TOOLS, ToolError, assertUniqueToolNames, type AnyTool, type ToolContext } from "./tools/registry.js";

/** What this server calls itself in the MCP handshake. */
export const SERVER_NAME = "transition-area-tools";
export const SERVER_VERSION = "0.1.0";

// At import, not per request: a duplicate name is a programming error,
// and the earlier it fails the less confusing it is.
assertUniqueToolNames();

/** What a sealed confirmation request names: exactly one call. */
interface ConfirmState {
  tool: string;
  runId: string;
  argsHash: string;
}

/**
 * The HMAC key for confirmation state. Module level, not per server: over
 * HTTP the factory builds a new server for every request, and the retry
 * that carries the human's answer is a different request from the one
 * that asked. A per-server key would fail to verify its own seal.
 */
const confirmCodec = createRequestStateCodec<ConfirmState>({ key: randomBytes(32), ttlSeconds: 300 });

/** What the human is asked, and what the answer must look like. */
const confirmSchema = z.object({ confirm: z.boolean() });

/** A stable hash of a call's arguments: same arguments, same hash, whatever the key order. */
function hashArgs(args: Record<string, unknown>): string {
  const sorted = Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b)));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 32);
}

function registerOneTool(server: McpServer, tool: AnyTool): void {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
    },
    async (rawArgs, mcpCtx) => {
      const args = rawArgs as Record<string, unknown>;
      // A fresh recorder per call, so this result reports only its own SQL.
      const { runner, queries } = createRecorder();

      // 1. The session.
      const read = readSession(mcpCtx.mcpReq._meta as Record<string, unknown> | undefined);
      if (!read.ok) {
        console.error(`[${SERVER_NAME}] ${tool.name}: ${read.error}`);
        return { content: [{ type: "text", text: `Internal error (a bug in the app, not a mistake in the call): ${read.error}` }], isError: true };
      }
      const session: LabSession | null = read.session;
      const runId = session?.runId ?? NO_SESSION_RUN;
      const enforce = session ? session.enforcePermissions : true;

      // Everything that comes back beside the result.
      const { applier, appliedIds } = createOverlayApplier(session);
      const meta = (permission: PermissionVerdict) => ({
        "lab/queries": queries,
        "lab/overlays": appliedIds,
        "lab/permission": permission,
        "lab/outbox": outboxFor(runId),
      });

      try {
        // 2. The ticket's customer, looked up here.
        const customer = sessionCustomer(runner, session);

        // 3. Layer 5: the rules.
        let permission = authorize(tool.name, args, { db: runner, session, customer, enforce });
        if (permission.decision === "refused") {
          return {
            content: [{ type: "text", text: `Refused by the tool server's permission check (${permission.rule}): ${permission.reason}.` }],
            isError: true,
            _meta: meta(permission),
          };
        }

        // 4. Layer 5: a human's confirmation, bound to this call.
        if (tool.needsConfirmation && enforce) {
          const argsHash = hashArgs(args);
          const state = mcpCtx.mcpReq.requestState<ConfirmState>();
          const bound = state !== undefined && state.tool === tool.name && state.runId === runId && state.argsHash === argsHash;

          if (!bound) {
            if (mcpCtx.mcpReq.inputResponses) {
              // An answer nobody asked for. Ignored — the human is asked.
              console.error(`[${SERVER_NAME}] ${tool.name}: unrequested confirmation ignored (run ${runId})`);
            }
            return inputRequired({
              inputRequests: {
                confirm: inputRequired.elicit({
                  message: `The assistant wants to read staff-only notes for customer ${String(args.customer_id)}` +
                    (session ? ` while handling ticket ${session.ticketId}` : "") + ". Allow it?",
                  requestedSchema: confirmSchema,
                }),
              },
              requestState: await confirmCodec.mint({ tool: tool.name, runId, argsHash }),
            });
          }

          const answer = acceptedContent(mcpCtx.mcpReq.inputResponses, "confirm", confirmSchema);
          if (answer?.confirm !== true) {
            const declined: PermissionVerdict = { decision: "declined", rule: permission.rule, reason: "a person declined the request" };
            return {
              content: [{ type: "text", text: "Refused: a person declined the request to read these staff notes." }],
              isError: true,
              _meta: meta(declined),
            };
          }
          permission = { decision: "confirmed", rule: permission.rule, reason: "a person confirmed the request" };
        }

        // 5. Run the tool.
        const ctx: ToolContext = {
          db: runner,
          session,
          customer,
          enforce,
          overlays: applier,
          fill: (text) => fillCanaries(text, session?.canaries),
          outbox: { add: (entry) => addToOutbox(runId, entry) },
        };
        // `as never` pairs with the widening in tools/types.ts. Safe here and
        // only here: the SDK has already validated these arguments against
        // the same schema that typed the tool's input.
        const { data, text } = tool.run(args as never, ctx);

        // The search tool filters rather than refuses; say so in the verdict.
        if (permission.decision === "allowed" && tool.name === "search_help_articles") {
          const withheld = (data as { withheldInternal?: number }).withheldInternal ?? 0;
          if (withheld > 0) permission = { decision: "filtered", rule: permission.rule, reason: `${withheld} internal article(s) withheld` };
        }

        // 6. The result.
        return {
          content: [{ type: "text", text }],
          // Every tool's data is an object (checked by its outputSchema),
          // which is the shape MCP requires of structuredContent.
          structuredContent: data as Record<string, unknown>,
          _meta: meta(permission),
        };
      } catch (error: unknown) {
        const permission: PermissionVerdict = { decision: enforce ? "allowed" : "not-enforced", rule: "", reason: "" };
        if (error instanceof ToolError) {
          return { content: [{ type: "text", text: error.message }], isError: true, _meta: meta(permission) };
        }
        if (error instanceof SessionError) {
          console.error(`[${SERVER_NAME}] ${tool.name}: ${error.message}`);
          return { content: [{ type: "text", text: `Internal error (a bug in the app, not a mistake in the call): ${error.message}` }], isError: true };
        }
        // stderr, never stdout — over stdio, stdout is the protocol.
        console.error(`[${SERVER_NAME}] ${tool.name} failed:`, error);
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Internal error in ${tool.name} (a bug in the tool server, not a mistake in the call): ${message}` }],
          isError: true,
          _meta: meta(permission),
        };
      }
    },
  );
}

/** The factory. A new server every call — see the header for why. */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    // The SDK verifies every echoed confirmation seal here, BEFORE the
    // handler runs; a tampered or expired one is refused at the seam with
    // "Invalid or expired requestState".
    { requestState: { verify: confirmCodec.verify } },
  );
  for (const tool of TOOLS) registerOneTool(server, tool);
  return server;
}
